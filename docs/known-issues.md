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
  **SMS, Telegram, and WhatsApp** — the bug was in the shared owner-enrollment
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

### Remaining gap — SMS

SMS owner self-service does not exist yet. When built, it **must** use the same
account-scoped pattern (`account_id` + `location_id IS NULL`) AND bring the SMS admin
lock (`withMobileEnrollmentLock`) to account scope (currently keyed by `business_id`).

---

## Dispatcher failure-handling enrollment writes still key by business_id

- **Severity:** Medium — a blocked recipient may not get marked unsubscribed,
  causing repeated failed sends. No data corruption.
- **Status:** Open. Deferred pending org-default-vs-per-location-override awareness.
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
