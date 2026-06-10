# SMS Channel Removal — Design

**Date:** 2026-06-09
**Status:** Approved approach (single atomic PR); spec pending user review
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

**Keep** (shared with WhatsApp): `twilio-verify.ts`, `twilio-intent.ts`,
`twilio-delivery-status.ts`, `parse-inbound.ts`, all `twilio-whatsapp-*.ts`,
`whatsapp-shared.ts`, the `twilio` npm package.

## Code refactors

- **Type union:** remove `'sms'` from `ChannelId`
  (`src/lib/notifications/channels/types.ts`). TypeScript then surfaces every
  remaining reference; fix each — channel factory (`channels/index.ts`),
  `constants.ts`, `enrollment-reducer.ts`, resolve-channels, delivery code.
- **Dispatcher** (`worker/jobs/notification/dispatch.ts`): remove the
  `reserveSmsCost`/`refundSmsCost` branch and the 21610 opt-out write path.
  Remove `SmsRecipientUnsubscribedError` from `worker/jobs/notification/errors.ts`.
- **Worker boot** (`worker/index.ts`): unregister the two SMS ingress routes.
  Drop `assertChannelsSmsEnv()` from `worker/config/startup-assert.ts`.
- **Offboarding purge** (`src/lib/account-offboarding/table-disposition.ts`,
  `purge-verification.ts`, `worker/jobs/account-offboarding/purge-stages.ts`
  + their tests): remove the two SMS tables from disposition, purge, and
  verification lists. Must land in the same PR as the table drop.
- **UI:** remove SMS from `ChannelsClient`/`ChannelsTabClient` pickers, admin
  `ChannelsPanel`, and `ComingSoonChannelRow` (SMS is no longer "coming soon" —
  it is gone).
- **Migration RLS tests** (`migration-035`/`migration-040` tests) and
  `ci:rls-audit` expectations: drop SMS-table assertions.

## Database migration

One new migration (next number per `.claude/reference/migrations-log.md` at
implementation time):

1. Defensive archive: `UPDATE channel_enrollments SET archived_at = now()
   WHERE channel = 'sms' AND archived_at IS NULL` — expected 0 rows in prod.
2. `DROP INDEX idx_channel_enrollments_sms_handle`; recreate with a
   WhatsApp-only predicate (`channel = 'whatsapp'`) **iff** a live query still
   uses it for WhatsApp handle lookups — plan phase confirms via the query
   sites before deciding drop vs. rewrite.
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

**Pre-flight gate (before merge):** run against the **prod** Supabase
project — counts of (a) live SMS enrollments
(`channel='sms' AND archived_at IS NULL`), (b) `sms_sender_opt_outs` rows,
(c) `sms_sender_opt_out_events` rows. All must be 0. Staging counts are
reported for awareness but may be nonzero test data; staging rows die with
the table drop.

## Config & docs

- **`.env.example`:** remove `TWILIO_MESSAGING_SERVICE_SID`,
  `TWILIO_VERIFY_SERVICE_SID`, `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS`,
  `SMS_DAILY_LIMIT_CENTS_GLOBAL`, `CHANNELS_SMS_ENABLED`. Keep
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `WORKER_PUBLIC_URL` (WhatsApp).
- **Living docs purged of SMS:** `.claude/reference/env-vars.md`,
  `.claude/reference/migrations-log.md` (append new migration entry),
  `docs/adding-communication-channels.md`, `docs/eservices-variables.md`,
  `docs/directory.md`.
- **Historical docs stay:** dated specs/plans under `docs/superpowers/`
  (`2026-04-21-phase1-sms*`, `2026-05-29-sms-channel-honest-coming-soon`)
  are immutable history, like old migrations.
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
  If staging has one in flight during deploy, channel resolution skips or
  fails that single channel — acceptable for staging test data.
- **Unknown channel strings in DB rows:** `channel` columns are TEXT; after
  removal, `'sms'` becomes an unknown channel value. The existing
  unknown-channel guard in the channel factory must throw/skip cleanly rather
  than crash the dispatcher loop — plan phase confirms the exact behavior and
  adds a test if missing.
- **Redis residue:** `cost:sms:*` keys expire naturally (86400s TTL); no
  cleanup needed.

## Out of scope

- WhatsApp and Telegram channels (unchanged).
- Any change to the email channel or notification dispatch architecture.
- Twilio account closure (Messaging Service retirement is an ops follow-up,
  not part of this change).
