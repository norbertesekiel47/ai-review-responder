# Known Issues

A registry of known, unresolved correctness issues. Each entry links to a fuller
design/fix doc where one exists. Add new issues at the top.

---

## Owner channel enrollment desyncs on multi-location accounts (cross-channel)

- **Severity:** High (data desync + 500s), but narrow blast radius (see below).
- **Status:** Resolved (`fix/owner-channel-account-scope`) for Telegram + WhatsApp.
  The org-default read/write paths (status GET + start/cancel/disable helpers, owner
  + admin callers) are now account-scoped (`account_id` + `location_id IS NULL`). The
  advisory lock is account-scoped. The WhatsApp single-location interim guard (PR #53)
  was removed.
- **Affects:** Owner self-service channel enrollment (`/settings/channels`) for
  **Telegram and WhatsApp** — the bug was in the shared owner-enrollment
  read/write paths, not any single channel.
- **Full write-up:** `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`

### What was wrong

The three code paths that touch `channel_enrollments` for owner self-service keyed
the table inconsistently:

| Path | Keys by |
|---|---|
| Page SSR hydration (display) | `account_id` (org-default = `location_id IS NULL`) |
| Runtime status read + start/cancel/disable | `business_id = user.locationId` (`user.primary_location_id`) |
| Uniqueness enforcement (migration 034) | `(account_id, channel, COALESCE(location_id, sentinel))` |

An org-default enrollment row carries the `business_id` of whoever created it. On a
**multi-location account with ≥2 owners whose primary locations differ**, a second
owner saw the channel as "connected" on the page (matched by `account_id`) but the
runtime API didn't see it (no `business_id = their location` row), so:

- Status widget desynced (page says connected, widget says not).
- **Disconnect → 404** (no matching row for their `business_id`).
- **Connect → 500** (INSERT tripped `channel_enrollments_account_channel_scope_uniq`;
  the non-mobile constraint name was classified as `EnrollmentDatabaseError`).

### RESOLVED (PR #135, 2026-05-28): Admin SMS lock + cross-channel precheck + SMS-row scope

- **Status:** Resolved. `withMobileEnrollmentLock` and its five callers now lock by
  `mobile_enroll:${accountId}`, and `verify/route.ts` prechecks other mobile channels
  by `account_id` + `location_id IS NULL`. A PR-review follow-up went further: ALL five
  SMS admin routes now read/write the SMS row by `account_id` + `channel = 'sms'` +
  `location_id IS NULL` — previously the row was keyed by `business_id` while the INSERT
  wrote org-default (`location_id` NULL), so an SMS row created under L1 was invisible
  from L2, causing a wasted Twilio Verify + late `one_mobile_per_scope` 409. SMS is
  one-per-account org-default (the 034 unique indexes make per-location SMS impossible),
  like Telegram/WhatsApp. The Twilio STOP ingress was already handle-global (TCPA), no
  change needed.
- **Affects:** `src/app/api/admin/channels/sms/` (`_shared.ts` + verify/confirm/cancel/disable/delete).

`sms/_shared.ts::withMobileEnrollmentLock` acquires the advisory lock under the key
`mobile_enroll:${businessId}` (per-location), while the Telegram and WhatsApp admin
routes lock under `mobile_enroll:${accountId}` (per-account). Similarly,
`sms/verify/route.ts` prechecks for an existing "other mobile channel" by `business_id`
rather than `account_id`.

Consequence on multi-location accounts: verifying SMS for location L2 can miss an
existing account-scoped Telegram/WhatsApp org-default row that was created under L1.
This means a Twilio Verify SMS may be dispatched, then the INSERT trips the
`one_mobile_per_scope` unique index and returns a late 409. The advisory lock also no
longer serializes SMS-verify against Telegram/WhatsApp start (the unique index still
prevents data corruption, but the lock window is mismatched).

Fix = account-scope `withMobileEnrollmentLock` and its five callers, plus the
`verify/route.ts` precheck query.

### RESOLVED (PR #132, 2026-05-28): Admin per-business channel status read

- **Status:** Resolved. The read resolves the account from the location, then reads
  account-scoped (`account_id` + `(location_id = $businessId OR location_id IS NULL)`),
  deduping per channel with per-location override beating org-default — mirroring
  `resolveChannels`. So an org-default row created under L1 now surfaces on L2's detail
  page, matching what admin start/disable act on. A PR-review follow-up also scoped the
  `last_activity_at` subquery to the viewed location (`nd.business_id = $businessId`)
  rather than the enrollment row's legacy `business_id`.
- **Affects:** `src/app/api/admin/businesses/[id]/channels/route.ts`

The admin business-detail page lists channel enrollments by `business_id` (one
location's view), but admin start/disable routes act on the account-scoped org-default
row (`account_id` + `location_id IS NULL`). On a multi-location account where the
org-default row was created under location L1, the business-detail page for L2 will
show the channel as "idle" while admin start returns `already_verified` (the existing
org-default row is not shown).

Fix = surface account-scoped org-default rows on that page, keying by `account_id`
and filtering `location_id IS NULL`.

---

## Dispatcher failure-handling enrollment writes (RESOLVED, PR #133)

- **Severity:** Medium — a blocked recipient may not get marked unsubscribed,
  causing repeated failed sends. No data corruption.
- **Status:** Resolved (PR #133, 2026-05-28). The four failure branches
  (`telegram_blocked`, `telegram_chat_not_found`, `whatsapp_blocked`,
  `whatsapp_invalid_recipient`) now scope the UPDATE by `account_id = ctx.accountId`
  plus the enrollment's location (`location_id IS NULL` for org-default,
  `location_id = <id>` for a per-location override, from `ResolvedChannel.location_id`).
  The `sms_unsubscribed` branch (now removed with SMS channel) was handle-global for TCPA.
- **Affects:** `worker/jobs/notification/dispatch.ts` failure branches for
  `telegram_blocked`, `telegram_chat_not_found`, `whatsapp_blocked`, and similar
  states that flip `channel_enrollments.status` via `WHERE business_id = ctx.businessId`.
- **Full write-up:** `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`

### What's wrong

When the dispatcher detects a blocked or missing recipient it flips the enrollment
status (e.g. to `unsubscribed`) with `WHERE business_id = ctx.businessId`. On a
multi-location account whose org-default row has `location_id IS NULL`, the
`business_id` FK still carries the value from the original INSERT, but the correct
lookup key for an org-default row is `account_id` (+ `location_id IS NULL`). If the
row was created under account-scope (post-fix) and the dispatcher still queries by
`business_id`, the UPDATE may miss the org-default row on multi-location accounts.

### Deferred because

The correct fix needs the dispatcher to distinguish between an org-default enrollment
(update by `account_id` + `location_id IS NULL`) and a per-location override (update
by `location_id`). `ctx.accountId` is available and can be used for the eventual fix.
The blast radius today is limited: the channel remains listed as active, leading to
repeated failed sends rather than data corruption. Admin can correct manually.
