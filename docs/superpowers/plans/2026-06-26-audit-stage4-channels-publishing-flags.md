# Stage 4 — the channels / publishing / poller feature-flag cluster

_Branch `refactor/audit-stage4-channels-publishing-flags`. Builds on 4a's `readFlag`
primitive (`src/lib/config/flags.ts`). Routes the eight worker-heavy feature flags
through four new `<feature>/flags.ts` accessors. Zero behavior change._

## The accessors — four new `flags.ts` modules
Each export is a one-line wrapper over the shared `readFlag` primitive
(byte-for-byte `process.env[name] === 'true'`). Server-authoritative (invariant #13:
never a `NEXT_PUBLIC_*` companion; the browser learns state through API responses /
props).

- **`src/lib/notifications/channels/flags.ts`**
  - `channelsTelegramEnabled()` → `readFlag('CHANNELS_TELEGRAM_ENABLED')`
  - `channelsWhatsappEnabled()` → `readFlag('CHANNELS_WHATSAPP_ENABLED')`
  - `emailChannelReconcileDisabled()` → `readFlag('EMAIL_CHANNEL_RECONCILE_DISABLED')`
    (the `*_DISABLED` name encodes the meaning; the call site still reads it as
    `=== 'true'` — true ⇒ the reconcile poller does not start).
- **`src/lib/publishing/flags.ts`**
  - `zernioPublishingEnabled()` → `readFlag('ZERNIO_PUBLISHING_ENABLED')`
  - `externalReplyImportEnabled()` → `readFlag('EXTERNAL_REPLY_IMPORT_ENABLED')`
  - `zernioRecentReviewPollDisabled()` → `readFlag('ZERNIO_RECENT_REVIEW_POLL_DISABLED')`
    (`*_DISABLED`; true ⇒ the recent-review poller does not start).
- **`src/lib/notifications/flags.ts`**
  - `notificationFailoverDisabled()` → `readFlag('NOTIFICATION_FAILOVER_DISABLED')`
    (`*_DISABLED`; true ⇒ the failover poller does not run).
- **`src/lib/ranking/flags.ts`**
  - `rankingTrackingEnabled()` → `readFlag('RANKING_TRACKING_ENABLED')`

None of the four modules reads `process.env` directly → none enters the process-env
baseline (they read via the allowlisted `src/lib/config/flags.ts`).

## Migrated reads — worker-heavy, swapped expression-for-expression
Each inline read was swapped preserving the exact boolean: `=== 'true'` → `accessor()`;
`!== 'true'` → `!accessor()`; `X === 'true' ? a : b` → `accessor() ? a : b`. Comment
lines and error-message / log strings that merely mention a flag name were left
untouched. All reader files are server-side (no `'use client'`), so importing the
server accessor is safe in every lane (Server Components, route handlers, ingress,
pollers, schedulers, worker boot).

### worker boot — `worker/index.ts`
- `shouldRunFailoverPoller()` start-guard → `if (notificationFailoverDisabled())`.
- The startup feature-flag log line → `channelsTelegramEnabled()` / `channelsWhatsappEnabled()`
  / `zernioPublishingEnabled()` (the `SelfServeSignup=…` field already used the 4b
  accessor). STAYS in the process-env baseline: still reads `PORT` +
  `WORKER_SHUTDOWN_GRACE_MS`.

### worker pollers / schedulers
- `background/pollers/EmailChannelReconcilePoller.ts` — start-guard
  → `if (emailChannelReconcileDisabled())`. Flag was its only non-exempt read → DROPPED
  from the baseline.
- `background/pollers/ZernioRecentReviewPoller.ts` — two reads:
  `if (!zernioPublishingEnabled())` and `if (zernioRecentReviewPollDisabled())`. Both
  flags were its only non-exempt reads → DROPPED from the baseline.
- `background/schedulers/RankingTrackingScheduler.ts` — `if (!rankingTrackingEnabled())`.
  STAYS in the baseline: still reads `RANKING_TRACKING_INTERVAL_MS`.

### worker ingress
- `ingress/stripe/shared.ts` — `if (!zernioPublishingEnabled()) return;`. DROPPED.
- `ingress/zernio/zernio.ts` — the webhook flag gate `if (!zernioPublishingEnabled())`.
  DROPPED.

### worker jobs
- `jobs/notification/eligibility.ts` — per-channel gate
  (`channelsTelegramEnabled()` / `channelsWhatsappEnabled()`). DROPPED.
- `jobs/zernio/zernio-ingest-shared.ts` — the `FLAG_ON` helper
  (`const FLAG_ON = (): boolean => externalReplyImportEnabled()`). DROPPED.

### app (Server Components / route handlers) — out of audit scope, still migrated
- `(authenticated)/dashboard/connect/select-location/page.tsx` —
  `if (!zernioPublishingEnabled())`.
- `api/zernio/disconnect/route.ts` — `if (!zernioPublishingEnabled())`.
- `api/admin/businesses/[id]/zernio-queue/route.ts` — the `force_drain` gate
  `if (!zernioPublishingEnabled())`.

These three `src/app` reads were inline holdouts the prior pass missed; migrated for a
clean inline-flag re-grep / `ci:static-policy`. `src/app/**` is outside the audit scope
(`src/lib/**` + `worker/**`), so they never affected the baseline.

### already migrated (prior pass on this branch)
`src/lib/notifications/channels/index.ts` (the `getChannel()` factory) and
`src/lib/admin/business-detail/mappers.ts` — both DROPPED from the baseline here (their
channel flags were the only non-exempt reads). The channels UI/admin/dashboard routes
and the Zernio connect routes were also already migrated.

## EXEMPT — `worker/config/startup-assert.ts` left inline
`assertChannelsTelegramEnv` / `assertChannelsWhatsAppEnv` / `assertZernioPublishingEnv`
read `process.env.<FLAG> !== 'true'` to decide whether to VALIDATE the flag's required
companion env. These are the boot-asserts that own flag/env presence and stay sanctioned
direct reads (already in `ALLOWLIST_FILES`). Not migrated.

## Baseline
`process-env` baseline **28 → 20** — 8 files dropped (their flag was the only non-exempt
read): `business-detail/mappers.ts`, `notifications/channels/index.ts`,
`EmailChannelReconcilePoller.ts`, `ZernioRecentReviewPoller.ts`,
`ingress/stripe/shared.ts`, `ingress/zernio/zernio.ts`, `notification/eligibility.ts`,
`zernio/zernio-ingest-shared.ts`. STAYS: `worker/index.ts` (PORT +
WORKER_SHUTDOWN_GRACE_MS) and `RankingTrackingScheduler.ts` (RANKING_TRACKING_INTERVAL_MS).
The four new `flags.ts` modules read no `process.env` directly → not added.

## Tests — no conversions needed
`readFlag` is NOT memoized, so every existing test that sets a flag in `process.env`
before exercising a migrated file still works — the accessor reads live. No test was
changed. Added a focused `__tests__/flags.test.ts` next to each of the four new modules,
locking every accessor to exact-`'true'`-only (true for `'true'`; false for
unset / `''` / `'false'` / `'TRUE'` / `'True'` / `'1'` / `' true '`).

## Behavior preservation
Each accessor is byte-for-byte `process.env.X === 'true'` — exactly what each inline read
did. Every call site kept its exact boolean (`=== 'true'` → accessor; `!== 'true'` →
`!accessor`; ternary → `accessor() ? a : b`).

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all green.
