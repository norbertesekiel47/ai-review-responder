# Known Issues

A registry of known, unresolved correctness issues. Each entry links to a fuller
design/fix doc where one exists. Add new issues at the top.

---

## Owner channel enrollment desyncs on multi-location accounts (cross-channel)

- **Severity:** High (data desync + 500s), but narrow blast radius (see below).
- **Status:** Open. Interim safeguard shipped for WhatsApp only (PR #53).
- **Affects:** Owner self-service channel enrollment (`/settings/channels`) for
  **SMS, Telegram, and WhatsApp** — the bug is in the shared owner-enrollment
  read/write paths, not any single channel.
- **Full write-up + proposed fix:** `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`

### What's wrong

The three code paths that touch `channel_enrollments` for owner self-service key
the table inconsistently:

| Path | Keys by |
|---|---|
| Page SSR hydration (display) | `account_id` (org-default = `location_id IS NULL`) |
| Runtime status read + start/cancel/disable | `business_id = user.locationId` (`user.primary_location_id`) |
| Uniqueness enforcement (migration 034) | `(account_id, channel, COALESCE(location_id, sentinel))` |

An org-default enrollment row carries the `business_id` of whoever created it. On a
**multi-location account with ≥2 owners whose primary locations differ**, a second
owner sees the channel as "connected" on the page (matched by `account_id`) but the
runtime API doesn't see it (no `business_id = their location` row), so:

- Status widget desyncs (page says connected, widget says not).
- **Disconnect → 404** (no matching row for their `business_id`).
- **Connect → 500** (INSERT trips `channel_enrollments_account_channel_scope_uniq`;
  the non-mobile constraint name is classified as `EnrollmentDatabaseError`).

### Who is affected

- **Single-location accounts: immune** (`business_id == primary_location_id` always).
- **Multi-location accounts with a single active owner: effectively immune** (that
  owner's `business_id` always matches the row they created).
- **Multi-location accounts with ≥2 owners on different primary locations: exposed**
  on SMS and Telegram **today**.

### Current mitigation

- **WhatsApp** owner self-service is gated to single-location accounts (server 403
  `multi_location_unsupported` in the owner start route + UI shows "coming soon" for
  multi-location accounts). Shipped in PR #53.
- **SMS and Telegram** are NOT yet guarded — they retain the pre-existing behavior
  and remain exposed for the multi-owner/multi-location case.

### Fix direction

Key the org-default owner-enrollment paths by account scope
`(account_id, channel, location_id IS NULL)` — matching the page hydration and the
unique index — across the shared status GET and all three channels' start/cancel/
disable helpers. Keep `business_id` only as the legacy FK written on INSERT. Then
remove the WhatsApp interim guard. Details in the design doc linked above.

### Edge case introduced by the interim guard

An account that enrolls WhatsApp while single-location and *later* adds locations
will see the owner WhatsApp row flip to "coming soon" while still enrolled. It
remains manageable from the admin console until the cross-channel fix lands.
