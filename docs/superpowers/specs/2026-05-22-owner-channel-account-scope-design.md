# Owner Channel Enrollment — Account-Scope Correctness (cross-channel) — Design

_Design spec — RepWorth — 2026-05-22_

**Status:** Approved — ready for implementation plan. (Was a stub surfaced during
the WhatsApp go-live PR #53 review; brainstormed + approved 2026-05-22.)

**Branch:** `fix/owner-channel-account-scope` (off `main`, which now includes the
merged PR #53 WhatsApp work).

## Problem

Owner self-service channel enrollment (`/settings/channels`) has a multi-location
desync because the code paths key the `channel_enrollments` table inconsistently:

| Path | Keys by | File |
|---|---|---|
| Page SSR hydration (display) | `account_id` (org-default = `location_id IS NULL`) | `src/app/(authenticated)/settings/channels/page.tsx` |
| Runtime status read (poll/refresh) | `business_id = user.locationId` | `src/app/api/dashboard/channels/route.ts:95` |
| Enrollment write (start/cancel/disable) | `business_id = user.locationId` | `src/lib/channels/{telegram,whatsapp}-enrollment.ts` + the per-channel routes |
| Uniqueness enforcement | `(account_id, channel, COALESCE(location_id, sentinel))` | `supabase/migrations/034_multi_location_schema.sql:375,386` |

`user.locationId` is the owner's `primary_location_id` (`src/lib/db/auth.ts:84`).
An org-default enrollment row carries the `business_id` of whichever owner created
it. On a **multi-location account with ≥2 owners whose primary locations differ**,
owner B (primary = L2) reading an org-default row created by owner A (business_id = L1):

- **Page** shows the channel connected (matches by `account_id`).
- **Status GET** returns nothing (no `business_id = L2` row) → widget desyncs.
- **Disconnect** → 404 (`disableXEnrollment` matches nothing for L2).
- **Connect** → INSERT `business_id = L2, location_id = NULL` trips
  `channel_enrollments_account_channel_scope_uniq` → `EnrollmentDatabaseError` → **500**
  (`src/lib/channels/unique-violation.ts`).

**Reachability today:** owner self-service exists only for **Telegram** (live,
unguarded) and **WhatsApp** (guarded single-location since PR #53). SMS has no
owner widget yet. **Single-location accounts are immune** (`business_id ==
primary_location_id` always). Pre-existing; WhatsApp mirrored the Telegram pattern.

## Root cause

Org-level owner enrollment is an **account-scoped** resource (`location_id IS NULL`),
but the runtime read/write paths address it by `business_id` — a legacy per-location
FK that is the wrong key for a row that belongs to the account, not one location.

## Approved approach

Make every org-default owner-enrollment path key by the same account scope the 034
unique index uses: **`account_id = <accountId> AND channel = <ch> AND location_id IS NULL`**.
`business_id` stays a NOT-NULL legacy FK, written on INSERT but **never used for
lookup**. **Query-only change — no migration, no backfill** (reads stop filtering by
`business_id`, so existing rows read correctly regardless of their stored
`business_id`). Robust to `is_primary` changes (doesn't depend on which location is
primary).

### Components

**1. Shared status GET — `src/app/api/dashboard/channels/route.ts`**
- The existing account lookup (line ~68) adds `a.id AS account_id`.
- The enrollment query changes `WHERE e.business_id = ${user.locationId}` →
  `WHERE e.account_id = ${accountId} AND e.location_id IS NULL` (keeps
  `archived_at IS NULL`). This is the linchpin: the polled status now matches the
  page's `account_id` hydration for every channel (email/telegram/whatsapp), so they
  cannot desync. Per-location override rows (`location_id` set) are correctly
  excluded — they belong to the page's separate overrides panel, not the org-default
  widget.

**2. Enrollment helpers — `src/lib/channels/telegram-enrollment.ts` + `whatsapp-enrollment.ts`**
- `startXEnrollment`, `cancelXEnrollment`, `disableXEnrollment` change their
  SELECT/UPDATE predicates from `business_id = $1` to
  `account_id = $1 AND channel = '…' AND location_id IS NULL` (plus the existing
  status/archived guards).
- `cancelX` / `disableX` signatures change from `(sql, businessId)` → `(sql, accountId)`.
- `startX` keeps both ids: looks up by `accountId` (+ channel + location_id IS NULL),
  and writes `business_id` on INSERT (see decision below). `location_id` stays unset
  (NULL = org-default), as today.

**3. Owner routes — telegram + whatsapp `start/cancel/disable`**
- They already resolve `accountId` (the subscription check joins `accounts`). Pass
  `accountId` to the helpers instead of `locationId`.
- **Advisory lock key** changes `mobile_enroll:${locationId}` → `mobile_enroll:${accountId}`,
  so concurrent enrollment by different owners on the same account actually
  serializes (today it wouldn't — different `locationId`s → different locks).

**4. Admin lock-key consistency — admin enrollment routes (INCLUDED per decision)**
- Admin enrollment also creates org-default rows (`location_id NULL`) but locks by
  `mobile_enroll:${businessId}`. Change the admin advisory-lock key to
  `mobile_enroll:${accountId}` everywhere the `mobile_enroll` lock is taken on the
  admin side — Telegram `start`, WhatsApp `start`, and SMS `verify` (via
  `withMobileEnrollmentLock`) — so an admin and an owner acting on the same
  account+channel mutually exclude. Without this, the account-scope unique index
  still prevents corruption but one side gets a raw 500 instead of a clean 409. The
  admin route already resolves the account; ~1 line each. (SMS has no admin `start` —
  its mobile-channel lock lives in the `verify` path.)

**5. Remove the WhatsApp interim guard**
- Delete the `getActiveLocationCount > 1 → 403 multi_location_unsupported` guard in
  the WhatsApp owner start route, and the `whatsappMultiLocationBlocked` UI gating in
  `page.tsx` + `ChannelsClient.tsx`. The widget returns for multi-location accounts.
  The "enrolled-while-single-then-multi" edge resolves automatically (reads are now
  account-scoped). Mark the issue resolved in `docs/known-issues.md`.

### Decision: `business_id` value written on INSERT

Write `business_id = user.locationId` (the enrolling owner's primary location) — the
current behavior. **Refinement from brainstorming:** we floated "set it to the
account's primary location," but since `business_id` is never read for the org-default
scope after this fix, the value is cosmetic; writing `user.locationId` is correct,
needs no extra `is_primary` lookup, and avoids coupling to a mutable primary flag.
(The NOT-NULL FK is satisfied either way.)

## Data flow (shape unchanged, account-keyed)

Owner taps Connect from any location → start route resolves `accountId` →
account-scoped advisory lock → `startXEnrollment` SELECTs the org-default row by
`(account_id, channel, location_id IS NULL)`, INSERTs if none → QR → inbound verify
(already token-hash based, location-agnostic) → status GET reads by
`account_id + location_id IS NULL` → "Connected" for **every** owner on the account.

## Error handling

Unchanged: `MultipleMobileChannelsError` → 409, `EnrollmentDatabaseError` → 500,
`already_verified` → 409. The account-scoped advisory lock + the 034 unique index
together resolve concurrent creates to one winner + a clean 409 for the loser
(no more raw 500 from a lost race).

## Testing

- **Regression (the exact bug), for Telegram AND WhatsApp:** seed a verified
  org-default row with `account_id` matching but `business_id ≠ user.locationId`;
  assert the status GET shows it connected, Disconnect succeeds (not 404), and a
  fresh Connect does not 500.
- **Concurrency:** two owners (different `locationId`, same account) connect
  concurrently → one wins, the other gets 409, exactly one row exists.
- **WhatsApp guard removed:** delete the single-location 403 test; add a test that
  multi-location accounts now receive the interactive widget (UI availability true).
- **Admin lock key:** assert admin start routes lock by `mobile_enroll:${accountId}`.
- **Update** `enroll-e2e.integration.test.ts` queue ordering (no `getActiveLocationCount`
  call; account-keyed SELECT/UPDATE).
- **unique-violation classifier:** keep the existing distinction between
  `account_channel_scope_uniq` (→ `EnrollmentDatabaseError`) and
  `one_mobile_per_scope` (→ `MultipleMobileChannelsError`).
- Full `pnpm test` + `pnpm typecheck` + `pnpm lint` green.

## File map

**Modify:**
- `src/app/api/dashboard/channels/route.ts` (status GET → account scope)
- `src/lib/channels/telegram-enrollment.ts` (3 helpers → account scope)
- `src/lib/channels/whatsapp-enrollment.ts` (3 helpers → account scope)
- `src/app/api/dashboard/channels/telegram/{start,cancel,disable}/route.ts` (pass accountId, lock by accountId)
- `src/app/api/dashboard/channels/whatsapp/{start,cancel,disable}/route.ts` (pass accountId, lock by accountId, **remove guard**)
- Admin advisory-lock key → accountId where the `mobile_enroll` lock is taken: `src/app/api/admin/channels/telegram/start/route.ts`, `…/whatsapp/start/route.ts`, and the SMS `verify` path (`withMobileEnrollmentLock`)
- `src/app/(authenticated)/settings/channels/page.tsx` + `ChannelsClient.tsx` (remove `whatsappMultiLocationBlocked` gating)
- Tests for all of the above + `docs/known-issues.md` (mark resolved)

## Non-goals (YAGNI)

- **SMS owner self-service** — none exists; not built here. The corrected
  account-scoped pattern is documented so a future SMS owner widget inherits it.
- **Per-location owner enrollment UX** — the page's per-location overrides panel
  (gated by `shouldUseMultiLocationSettings`) is a separate concern; this fix is the
  org-default scope only.
- **Any migration / data backfill.**
