# Owner Channel Enrollment — Account-Scope Correctness (cross-channel) — Design

_Design spec — RepWorth — 2026-05-22_

**Status:** Proposed (follow-up task). Surfaced during the WhatsApp go-live PR review.
Needs its own implementation plan before execution.

## Problem

Owner self-service channel enrollment (`/settings/channels`) has a multi-location
desync because three code paths key the `channel_enrollments` table inconsistently:

| Path | Keys by | File |
|---|---|---|
| Page SSR hydration (display) | `account_id` (org-default = `location_id IS NULL`) | `src/app/(authenticated)/settings/channels/page.tsx:108,142` |
| Runtime status read (poll/refresh) | `business_id = user.locationId` | `src/app/api/dashboard/channels/route.ts:94` |
| Enrollment write (start/cancel/disable) | `business_id = user.locationId` | `src/lib/channels/{telegram,whatsapp}-enrollment.ts`; the per-channel routes |
| Uniqueness enforcement | `(account_id, channel, COALESCE(location_id, sentinel))` | `supabase/migrations/034_multi_location_schema.sql:375,386` |

`user.locationId` is the owner's `primary_location_id` (`src/lib/db/auth.ts:84`).
An org-default enrollment row carries the `business_id` of whichever owner created
it. On a **multi-location account with ≥2 owners whose primary locations differ**,
owner B (primary = L2) reading an org-default row created by owner A (business_id = L1)
sees:

- **Page** shows WhatsApp/Telegram/SMS connected (matches by `account_id`).
- **Status GET** returns nothing (no `business_id = L2` row) → widget desyncs.
- **Disconnect** → 404 (`disableXEnrollment` matches nothing for L2).
- **Connect** → INSERT `business_id = L2, location_id = NULL` trips
  `channel_enrollments_account_channel_scope_uniq` (account already has an
  org-default row) → `EnrollmentDatabaseError` → **500**
  (`src/lib/channels/unique-violation.ts:68`).

**Scope of impact:** all three chat channels (SMS, Telegram, WhatsApp) share this
pattern — the status GET is channel-agnostic. **Single-location accounts are
immune** (`business_id == primary_location_id` always). The bug is **pre-existing**
(predates the WhatsApp go-live branch); WhatsApp's owner routes faithfully mirror
the Telegram pattern.

## Root cause

Org-level owner enrollment is conceptually an **account-scoped** resource
(`location_id IS NULL`), but the runtime read/write paths address it by
`business_id`. `business_id` is a legacy per-location FK; it is the wrong key for
an org-default row, which belongs to the account, not a single location.

## Proposed fix (cross-channel)

Make the org-default owner enrollment paths key by **account scope**, matching the
page hydration and the unique index:

1. **Status GET** (`src/app/api/dashboard/channels/route.ts`): query
   `WHERE account_id = ${user.accountId} AND location_id IS NULL AND archived_at IS NULL`
   (resolve `accountId` from the session/business as the routes already do).
2. **Enrollment helpers** (`telegram-enrollment.ts`, `whatsapp-enrollment.ts`,
   and the SMS equivalent): `startXEnrollment` / `cancelXEnrollment` /
   `disableXEnrollment` SELECT/UPDATE by `(account_id, channel, location_id IS NULL)`.
   Keep `business_id` as the legacy FK value written on INSERT only (or backfill it
   to the owner's primary location — TBD during planning).
3. **Per-channel routes**: pass `accountId` (already resolved for the subscription
   check) to the helpers instead of `locationId`.
4. **Email** path is already account-correct — confirm no change needed.

## Tests

- Regression: account_id matches, org-default row has `business_id ≠ user.locationId`
  → status shows connected, disconnect succeeds (not 404), re-connect does not 500.
- Run the matrix for SMS + Telegram + WhatsApp.
- Distinguish `channel_enrollments_account_channel_scope_uniq` (account-scope dup)
  from `channel_enrollments_one_mobile_per_scope` (mobile exclusivity) in the
  unique-violation classifier tests.

## Interim safeguard (already shipped on the WhatsApp go-live branch)

Until this lands, WhatsApp owner self-service is gated to **single-location
accounts only** (server guard in the owner start route + UI shows "coming soon" for
multi-location accounts). SMS/Telegram retain their pre-existing behavior; this fix
should remove the WhatsApp interim guard as part of its rollout.

## Non-goals

- Per-location owner enrollment UX (the page already has a per-location overrides
  panel gated by `shouldUseMultiLocationSettings`; this fix is about the org-default
  scope only).
