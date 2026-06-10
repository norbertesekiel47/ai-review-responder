# SMS Channel Removal — Design

**Date:** 2026-06-09
**Status:** Approved approach (single atomic PR); hardened via 3-round
cross-model adversarial review (grill-me-codex, converged APPROVED); spec
pending user review
**Decision owner:** Norbert

## Goal & scope

Remove SMS as a notification channel from RepWorth entirely — code, schema,
config, and living docs. WhatsApp, Telegram, and email are untouched.

The Twilio foundation **stays** because WhatsApp depends on it: the `twilio`
npm package, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, signature verification
(`twilio-verify.ts`), intent classification (`twilio-intent.ts`), the shared
delivery-status ingress (`twilio-delivery-status.ts`), and `WORKER_PUBLIC_URL`.

**Risk posture:** SMS was never live in production — `CHANNELS_SMS_ENABLED`
defaults off, was never flipped (10DLC registration was the precondition and
never happened). This is dead-code removal with no behavioral risk window,
so no phased rollout is needed. It still carries a migration, so it rides
`staging` first per project convention.

Verified coupling that makes the table drop safe: WhatsApp's STOP handling
(`twilio-whatsapp-inbound.ts`) flips `channel_enrollments` directly and never
reads or writes the `sms_sender_opt_out*` tables. Those tables are SMS-only.

## Sequencing decision

**Single atomic PR** (code + migration + docs together), chosen over a
two-PR split or a code-only soft removal:

- SMS is already inert, so the safety a phased removal buys protects against
  a hazard that doesn't exist.
- Atomicity keeps the offboarding purge code that references the
  `sms_sender_opt_out*` tables in the same PR as the `DROP TABLE`, so there is
  no intermediate state where code and schema disagree.
- One review, one staging dry-run, one prod promotion.

## Code removal — delete outright

| Area | Files |
|---|---|
| Channel implementation | `src/lib/notifications/channels/sms-channel.ts`, `src/lib/notifications/sms-body.ts`, their tests |
| Cost tracking | `src/lib/costs/sms-tracker.ts` + test, `worker/jobs/notification/sms-budget.ts` |
| Ingress (SMS-only) | `worker/ingress/twilio/twilio.ts` (SMS status callback + inbound STOP/START) and its SMS-specific tests (`twilio-inbound`, `twilio-status`) |
| Admin API | `src/app/api/admin/channels/sms/` — entire directory (start, verify, confirm, cancel, disable, delete, status, `_shared.ts`, tests) |
| UI | `src/components/admin/SmsEnrollmentWidget.tsx` |
| Worker tests | `worker/jobs/notification/__tests__/NotificationWorker-sms.test.ts` |
| Offboarding stage | `runSmsOptOutPurgeStage` in `worker/jobs/account-offboarding/purge-stages.ts` (its `channel IN ('sms','whatsapp')` handle query is internal to the stage and dies with it) |

**Keep** (shared with WhatsApp): `twilio-verify.ts`, `twilio-intent.ts`,
`twilio-delivery-status.ts`, `parse-inbound.ts`, all `twilio-whatsapp-*.ts`,
`whatsapp-shared.ts`, the `twilio` npm package.

## Code refactors

- **Type union:** remove `'sms'` from `ChannelId`
  (`src/lib/notifications/channels/types.ts`). TypeScript then surfaces every
  remaining reference; fix each — channel factory (`channels/index.ts`, incl.
  the `SmsRecipientUnsubscribedError` re-export), `constants.ts`,
  `enrollment-reducer.ts`, resolve-channels, delivery code.
- **Runtime stale-row guard** (the type sweep cannot catch TEXT columns):
  `resolve-channels.ts` filters its SQL to the supported channel set
  (`email/telegram/whatsapp`); `dispatch.ts` skips any unsupported channel
  value BEFORE the `approval_links` insert (today the link is created before
  `getChannel()` throws — a stale `'sms'` row would otherwise leak an unsent
  approval link). One consistent rule: no link, no send, no crash.
  `getChannel()`'s unknown-channel throw remains only as defense-in-depth.
  Regression test: stale `'sms'` enrollment produces no approval link.
- **Redis channel cache:** bump the `rch:channels:` cache key namespace
  (versioned) so cached resolutions naming `sms` die at deploy rather than
  surviving up to the 300s TTL.
- **Owner override API** (zod string unions are invisible to the type sweep):
  remove `'sms'` from both schemas in
  `src/app/api/settings/channels/override/route.ts` and from the refresh
  filter in `overrides/route.ts`; add a rejection test (`channel:'sms'` → 400).
- **Dispatcher** (`worker/jobs/notification/dispatch.ts`): remove the
  `reserveSmsCost`/`refundSmsCost` branch and the 21610 opt-out write path.
  Remove `SmsRecipientUnsubscribedError` from `worker/jobs/notification/errors.ts`.
- **Worker boot** (`worker/index.ts`): unregister the two SMS ingress routes.
  Drop `assertChannelsSmsEnv()` from `worker/config/startup-assert.ts`.
- **Offboarding purge** (same PR as the table drop):
  `src/lib/account-offboarding/table-disposition.ts`, `purge-verification.ts`,
  `worker/jobs/account-offboarding/PurgeWorker.ts` (imports/calls
  `runSmsOptOutPurgeStage`), `worker/jobs/account-offboarding/purge-helpers.ts`
  (`smsOptOutScrubScopeRecord` + SMS scrub-scope types) + their tests — remove
  the two SMS tables and the SMS purge stage end-to-end.
- **UI:** remove SMS from `ChannelsClient`/`ChannelsTabClient` pickers, admin
  `ChannelsPanel`, `ComingSoonChannelRow` (SMS is no longer "coming soon" —
  it is gone), `settings/channels/page.tsx` (known-channel list), and
  `PerLocationOverridePanel.tsx` (hard-coded SMS entry).
- **API/admin contracts:** remove `available.sms` from
  `/api/dashboard/channels` (route.ts), `smsEnabled` from the business-detail
  mapper (`src/lib/admin/business-detail/mappers.ts`) and its `ChannelsPanel`
  consumer; drop the SMS option from the admin notifications channel filter —
  BOTH the UI (`src/app/admin/notifications/page.tsx`) and the backend filter
  branch (`src/app/api/admin/notifications/route.ts`), with the filter
  contract test updated. Historical `'sms'` delivery rows stay in the DB,
  reachable via SQL only.
- **CI inventories:** remove the two SMS tables from
  `scripts/ci/tenant-tables.ts`, `scripts/ci/tenant-scope-allowlist.ts`, and
  `docs/security/rls-inventory.md`; retarget any analyzer tests referencing
  them.
- **Historical migration tests stay untouched** — `migration-035`/
  `migration-040` tests validate immutable SQL files and remain as-is. The
  new migration gets its own structure test instead.

## Database migration

One new migration (next number per `.claude/reference/migrations-log.md` at
implementation time):

1. Defensive archive: `UPDATE channel_enrollments SET archived_at = now()
   WHERE channel = 'sms' AND archived_at IS NULL` — expected 0 rows in prod.
2. Replace `idx_channel_enrollments_sms_handle` with
   `idx_channel_enrollments_whatsapp_handle` — predicate
   `channel = 'whatsapp' AND handle IS NOT NULL AND archived_at IS NULL`.
   Verified consumer: the WhatsApp STOP handler updates by
   `handle + channel='whatsapp' + archived_at IS NULL`
   (`twilio-whatsapp-inbound.ts:303-311`).
3. Drop + recreate `channel_enrollments_one_mobile_per_scope` with predicate
   `channel IN ('telegram', 'whatsapp')`.
4. `DROP TABLE sms_sender_opt_out_events` then `sms_sender_opt_outs`
   (events holds the FK).

Constraints honored:

- Historical migrations (022, 027, 034, 035) are immutable — untouched.
- `notification_deliveries` / `channel_enrollments` `channel` columns stay
  TEXT; historical `'sms'` rows (staging test data only, if any) are left in
  place or archived, never rewritten.
- Migration applies **staging first, then prod, in lockstep** per the
  standard procedure.

**Pre-flight gate — run TWICE: before merge AND immediately before the prod
migration apply** (query output pasted into the PR/deploy checklist). Against
the **prod** Supabase project, ALL must be 0:

- `channel_enrollments` where `channel='sms'` (any, including archived)
- `sms_sender_opt_outs` and `sms_sender_opt_out_events` row counts
- `approval_links` where `channel='sms'`
- `notification_deliveries` where `channel='sms'`
- `inbound_events` from the SMS path — exact SQL:
  `event_type = 'inbound_sms'`, PLUS Twilio status events tied to SMS
  (joined to `notification_deliveries.channel='sms'`, or payload `From`/`To`
  present and NOT LIKE `'whatsapp:%'`)
- pending `job_outbox` / queued `send_notification` payloads naming `sms`

Any nonzero in prod → STOP, export/retain the data, reassess with owner — no
silent proceed. Staging: counts reported for awareness; only
`sms_sender_opt_out*` rows die with the table drop. Other staging SMS
artifacts (enrollments archived by the migration; historical deliveries,
links, inbound events, outbox rows) remain and are ignored by the runtime
guard — no staging-only cleanup needed.

## Config & docs

- **`.env.example`:** remove `TWILIO_MESSAGING_SERVICE_SID`,
  `TWILIO_VERIFY_SERVICE_SID`, `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS`,
  `SMS_DAILY_LIMIT_CENTS_GLOBAL`, `CHANNELS_SMS_ENABLED`. Keep
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `WORKER_PUBLIC_URL` (WhatsApp).
- **Living docs purged of SMS:** `.claude/reference/env-vars.md`,
  `.claude/reference/migrations-log.md` (append new migration entry),
  `docs/plans/adding-communication-channels.md`, `docs/eservices-variables.md`,
  `docs/directory.md`, `docs/runbooks/deployment-guide.md`,
  `docs/security/vendor-risk-register.md`, `docs/known-issues.md`,
  `docs/sass_ready/21-mobile.md`, `docs/sass_ready/26-financial-operations.md`,
  `docs/security/access-checklist.md`, `docs/launch-ready-part2.md`, and
  **user-facing legal copy** `src/lib/legal/content.ts` (SMS/Twilio mentions —
  legal text change flagged to owner in the PR).
- **Historical docs stay:** dated specs/plans under `docs/superpowers/`
  (`2026-04-21-phase1-sms*`, `2026-05-29-sms-channel-honest-coming-soon`)
  are immutable history, like old migrations.
- **Final sweep (closing step):** `rg -i '\bsms\b|twilio'` across `docs/` and
  `src/` — every hit classified one of: `kept: WhatsApp/shared Twilio`,
  `remove/update: SMS-specific`, or `historical: dated spec/plan`.
- **Ops follow-up after prod deploy** (manual, listed in the PR description):
  delete the four SMS env vars from Railway (staging + prod); retire the
  Twilio Messaging Service / Verify Service if nothing else uses them.

## Testing & verification

- SMS-specific tests are deleted with their code. Multi-channel tests
  (`resolve-channels`, `delivery`, `enrollments`, `e2e/owner-channels.spec.ts`)
  are updated to the three-channel world (email, telegram, whatsapp).
- Full local gate before the PR: `pnpm lint && pnpm typecheck && pnpm test`,
  plus `pnpm ci:tenant-scope && pnpm ci:rls-audit` (DB-touching change),
  plus `pnpm build`.
- Staging validation after merge to `staging`: worker boots clean (no SMS
  startup assertion), migration applies cleanly, WhatsApp/Telegram/email
  channel resolution still works. Then promote to `main` via PR and apply the
  migration to prod.

## Error handling & edge cases

- **In-flight SMS notification jobs:** impossible in prod (flag was never on).
  If staging has one in flight during deploy, the dispatch guard skips it
  before approval-link creation — no link, no send, no crash.
- **Unknown channel strings in DB rows:** `channel` columns are TEXT; after
  removal, `'sms'` becomes an unknown channel value. Primary guard is the
  resolve-channels SQL filter + dispatch skip (above); `getChannel()`'s
  unknown-channel throw is defense-in-depth only. Regression test covers a
  stale `'sms'` enrollment row.
- **Redis residue:** `cost:sms:*` keys expire naturally (86400s TTL); no
  cleanup needed.

## Out of scope

- WhatsApp and Telegram channels (unchanged).
- Any change to the email channel or notification dispatch architecture.
- Twilio account closure (Messaging Service retirement is an ops follow-up,
  not part of this change).
