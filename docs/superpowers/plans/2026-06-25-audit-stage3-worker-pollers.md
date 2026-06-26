# Stage 3 BATCH — worker-pollers config migration

_Branch `refactor/audit-stage3-worker-pollers`. Migrates the `worker/background/pollers/**`
raw `process.env.*` reads onto the Stage-2 typed config accessors
(`src/lib/config/worker.ts`), following the Stage-3 conventions established by the
email pilot (`docs/superpowers/plans/2026-06-25-audit-stage3-pilot-email-config.md`)
and the Stripe batch (`2026-06-25-audit-stage3-stripe-config.md`)._

## Why this batch

The pollers are the densest cluster of poller-tuning vars in the campaign:
intervals, batch sizes, windows, retry/cooldown bounds, thresholds, and two
alerting/identity strings. Every one is a `process.env.X ? parse : DEFAULT`
(or `parseInt(X || '', 10)` + `Number.isFinite && > 0`) truthy-checked read — so
they ALL migrate to `rawOptionalVar` (convention #7): the call site owns its own
parse/default/NaN/range guard, and `rawOptionalVar` preserves `''`/`'   '`/unset
byte-for-byte.

**Hard rule (campaign-wide): ZERO PRODUCTION behavior change.** Every default,
parse, NaN/range guard, truthy check, and clamp is preserved EXACTLY. Existing
poller tests pass unchanged in assertion; a test's env-setup *mechanism* is
refactored only where the memoized accessor requires it (convention #6) — that is
assertion-preserving (runtime env is immutable, so a memoized snapshot equals a
live read), not a behavior change.

The Stage-3 conventions governing this batch (full text in the pilot plan):
- **#2** env-indicator exempt (`NODE_ENV`, `MOCK_EXTERNAL_APIS`, `VERCEL_*`) — stay direct.
- **#3** `*_ENABLED`/`*_DISABLED` flag-like toggles → Stage 4 — left untouched.
- **#4 (Stripe refinement)** worker-ONLY files use **`getWorkerConfig()`** (worker
  lane: self-loads dotenv, safe to call from a worker module). All poller files are
  worker-only (no Next-route consumer), so all use `getWorkerConfig()`, never
  `getServerConfig()`.
- **#5** tolerate-absent → optional schema field, NOT an asserting accessor.
- **#6** test-isolation: a test mutating a migrated var mid-file needs the memo cleared.
- **#7** migrated RAW reads use `rawOptionalVar` (faithful `''`/`'   '`/unset passthrough).

### Runtime-read constraint (convention #4) — module-level reads moved into functions

Three files read a tuning var at **module top level** (frozen at import). Convention
#4 forbids calling `getWorkerConfig()` at module import. Each is moved to a lazy
runtime read inside the function that uses it, preserving the value (the worker env
is immutable after `worker/env.ts` boot, so a once-at-import constant equals a
once-at-first-call memoized read):

- `OutboxPoller.ts` — `POLL_INTERVAL_MS`, `BATCH_SIZE`, `DISPATCH_TIMEOUT_MS`,
  `MAX_CYCLE_MS` were module-level `const`s; now lazy getters read at `pollOutbox()`
  / `startOutboxPoller()` time. (`MAX_CYCLE_MS`'s `POLL_INTERVAL_MS * 4` fallback is
  preserved.)
- `HealthAlertPoller.ts` — `POLL_INTERVAL_MS` module-level `const` → lazy getter
  read in `pollHealthAlerts()` / `startHealthAlertPoller()`.
- `health-alert/emit.ts` — `PROBE_MONITOR_SLUG` module-level `const` → read inside
  `recordProbeCheckIn()`.

## Scope — migrated vars (grouped by file)

All reads below are `getWorkerConfig().X` with the call site's parse/default
**preserved byte-for-byte**. Each var is added to `workerSchema` as `rawOptionalVar`
(unless already present — see Schema section).

| File | Migrated var(s) | Call-site parse/default (preserved) |
|---|---|---|
| `AccountOffboardingAccessEndPoller.ts` | `ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS`, `ACCOUNT_OFFBOARDING_ACCESS_END_BATCH_SIZE` | `parseInt(X \|\| '', 10)`; interval `Finite && >0 ? : 60000`; batch `Finite && >=1`, clamp `>100→100`, else 25 |
| `AccountOffboardingPurgePoller.ts` | `ACCOUNT_OFFBOARDING_PURGE_INTERVAL_MS`, `ACCOUNT_OFFBOARDING_PURGE_BATCH_SIZE`, `ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` | interval/batch as above; window `Finite && >0`, `Math.min(raw, 3-day cap)`. `NODE_ENV`/`VERCEL_ENV` guard at L46 stays direct (exempt #2) |
| `AccountOffboardingPurgeReminderPoller.ts` | `ACCOUNT_OFFBOARDING_PURGE_REMINDER_INTERVAL_MS`, `ACCOUNT_OFFBOARDING_PURGE_REMINDER_BATCH_SIZE` | interval/batch as above (default 25) |
| `AccountOffboardingReactivationResetPoller.ts` | `ACCOUNT_OFFBOARDING_REACTIVATION_RESET_INTERVAL_MS`, `ACCOUNT_OFFBOARDING_REACTIVATION_RESET_BATCH_SIZE` | interval/batch as above (default 25) |
| `AccountOffboardingTeardownRetryPoller.ts` | `ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_INTERVAL_MS`, `ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_BATCH_SIZE`, `ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_COOLDOWN_MS`, `ACCOUNT_OFFBOARDING_TEARDOWN_MAX_RETRIES` | interval default 60000; batch default 10 clamp 100; cooldown `Finite && >0 ? : 5min` then `floor(ms/1000)`; maxRetries `Finite && >0 ? : 12` |
| `AnalyticsDispatchPoller.ts` | `ANALYTICS_DISPATCH_POLL_INTERVAL_MS`, `ANALYTICS_DISPATCH_BATCH_SIZE` | `parseInteger` helper (`!value \|\| !/^\d+$/.test(value.trim()) → default`); interval `>0 ? : 30000`; batch `max(1, min(…, 250))` default 50 |
| `ArchivalPoller.ts` | `ARCHIVAL_INTERVAL_MS` | `if (!envVal) DEFAULT`; `parseInt`; `Finite && >0 ? : 86400000` |
| `CancellationGracePoller.ts` | `CANCELLATION_GRACE_INTERVAL_MS` | same shape; default 86400000 |
| `CleanupAbandonedSignupsPoller.ts` | `CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE`, `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` | `envVal ? parseInt : NaN`; `Finite && >0 ? : DEFAULT`. `SELF_SERVE_SIGNUP_ENABLED` flag at L270 stays (Stage 4) |
| `EmailChannelReconcilePoller.ts` | `EMAIL_CHANNEL_RECONCILE_BATCH_SIZE`, `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS` | batch `envBatch ? parseInt : NaN`, `Finite && >0`, `min(req, MAX)`; interval same shape. `EMAIL_CHANNEL_RECONCILE_DISABLED` flag (L212) + `MOCK_EXTERNAL_APIS` (L216) stay |
| `EngagementMonitorPoller.ts` | `ENGAGEMENT_MONITOR_INTERVAL_MS` | `if (!envVal) DEFAULT`; default 86400000 |
| `HealthAlertPoller.ts` | `HEALTH_ALERT_POLL_INTERVAL_MS` | `parseInt(X \|\| '300000', 10)` — default-literal preserved (moved off module top level) |
| `NotificationFailoverPoller.ts` | `NOTIFICATION_FAILOVER_INTERVAL_MS`, `ADMIN_NOTIFICATION_EMAIL` (×2) | interval default 300000-class; `ADMIN_NOTIFICATION_EMAIL` raw truthy `if (adminEmail)` / `if (!adminEmail)` — `rawOptionalVar` keeps `'   '` truthy |
| `OutboxPoller.ts` | `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_DISPATCH_TIMEOUT_MS`, `OUTBOX_POLL_MAX_CYCLE_MS` | interval `\|\| '30000'`; batch `\|\| '50'`, `Finite && >=1`, clamp `>500→500`; timeout `\|\| '10000'`, `>=1000`; maxCycle `Finite && >=1000 ? : max(interval*4, 60000)` (moved off module top level) |
| `ZernioRecentReviewPoller.ts` | `ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS`, `ZERNIO_RECENT_REVIEW_POLL_PAGE_SIZE`, `ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES`, `ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS`, `ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY`, `ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS`, `ZERNIO_RECENT_REVIEW_POLL_INTERVAL_MS` | `readPositiveInt(name, fallback)` dynamic helper: `parseInt(X ?? '', 10)`, `Finite && >0 ? : fallback`. The dynamic `process.env[name]` becomes `getWorkerConfig()[name]` (name keyof WorkerConfig). 2 flags stay (Stage 4) |
| `billing-reconciliation/drift-alert.ts` | `SENTRY_DSN` | runtime `if (X)` truthy gate (Sentry vs warn-log fallback) — `rawOptionalVar` keeps `'   '` truthy |
| `health-alert/checks.ts` | `HEALTH_ALERT_PENDING_AGE_S`, `HEALTH_ALERT_FAILED_WINDOW_S`, `HEALTH_ALERT_FAILED_THRESHOLD`, `HEALTH_ALERT_STALE_DISPATCHING_S`, `HEALTH_ALERT_FLAGGED_OPEN_THRESHOLD`, `HEALTH_ALERT_ZERO_DELIVERY_WINDOW_S` | `num(X, fallback)`: `parseInt(X ?? '', 10)`, `Finite && >=0 ? : fallback` (threshold 0 valid) |
| `health-alert/emit.ts` | `HEALTH_ALERT_MONITOR_SLUG` | `X \|\| 'health-alert-poller'` (moved off module top level) |

**Already migrated (Stripe batch, untouched here):**
`StripeLocationsReconcilePoller.ts` `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS`.

### NOT migrated (left as-is, reported)

- **Flags → Stage 4:** `SELF_SERVE_SIGNUP_ENABLED` (Cleanup),
  `EMAIL_CHANNEL_RECONCILE_DISABLED` (EmailChannel),
  `STRIPE_LOCATIONS_RECONCILE_DISABLED` (StripeReconcile, already in baseline),
  `ZERNIO_PUBLISHING_ENABLED` + `ZERNIO_RECENT_REVIEW_POLL_DISABLED` (Zernio).
- **Env indicators (exempt #2):** `NODE_ENV`/`VERCEL_ENV` (Purge L46),
  `MOCK_EXTERNAL_APIS` (EmailChannel L216, StripeReconcile L214).

## Schema changes (`src/lib/config/worker.ts`)

- **NEW `rawOptionalVar` fields (32):** every migrated var above EXCEPT the two
  already in `workerSchema` (`ADMIN_NOTIFICATION_EMAIL`, `SENTRY_DSN`) and the
  already-present `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS`. Count: 34 distinct
  migrated vars − 2 (switched, below) = 32 new fields.
- **`opt` → `rawOpt` switches (2):** `ADMIN_NOTIFICATION_EMAIL` and `SENTRY_DSN`
  were `optionalVar`; switched to `rawOptionalVar` because the migrated call sites
  read them RAW (truthy `if (adminEmail)` / `if (process.env.SENTRY_DSN)`), and the
  collapsing `optionalVar` would map `'   '`→`undefined`, flipping the truthy check
  (#7). **Unaffected by the switch:** the boot asserts `assertAdminNotificationEmail`
  / `assertAlertSinkEnv` (`worker/config/startup-assert.ts`) read `process.env.X`
  **directly** with their own `value.trim().length === 0` check — they do NOT go
  through `getWorkerConfig()`, so the whitespace-as-absent boot semantics are
  preserved regardless of the field. (Verified: `startup-assertion.test.ts`
  whitespace cases stay green.)
- `WORKER_REQUIRED_VARS` unchanged (all new fields optional) → `ci:config-coverage`
  unaffected.

## Test-only memo reset (`resetWorkerConfigForTests`)

`getWorkerConfig()` memoizes the first parse. Four poller test files assert a value
that depends on a migrated var **mutated mid-file** (or twice within one test), so
the memo must be cleared between reads. These files statically import the poller
(and call `runOnce()`/the reader in ~30 places), so the convention #6
set→`resetModules()`→dynamic-import dance would mean rewriting every call site.

Instead, add a narrow **test-only** export to `worker.ts`:
```ts
export function resetWorkerConfigForTests(): void { memo = undefined; }
```
This matches the established house pattern (`resetStripeClientForTests`,
`resetConnectionCursorForTests`, `__resetPollerHeartbeatState`). It clears ONLY the
memo; it does NOT reset `ensureWorkerDotenvLoaded`'s `loaded` flag, so dotenv is not
re-run and a test's `delete process.env.X` is never repopulated from a real
`.env.local`. The next `getWorkerConfig()` re-parses the CURRENT `process.env`.

**Called in `beforeEach` of the 4 value-driven static-import test files:**
- `AnalyticsDispatchPoller.test.ts` — batch/interval override cases (incl. the one
  test that mutates `ANALYTICS_DISPATCH_BATCH_SIZE` twice: `'999'`→`'0'`; a reset is
  inserted between the two reads so both `250` and `1` assertions hold).
- `CleanupAbandonedSignupsPoller.test.ts` — `CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE`
  `'5'` vs unset(100) vs `'not-a-number'`(100).
- `ZernioRecentReviewPoller.test.ts` — per-test `ZERNIO_RECENT_REVIEW_POLL_*`
  overrides (max-pages/max-connections/concurrency/deadline).
- `AccountOffboardingPurgePoller.test.ts` —
  `ACCOUNT_OFFBOARDING_PURGE_WINDOW_OVERRIDE_MS` set/clamped/cleared across tests.

**NOT converted (value not assertion-driven):** `AccountOffboardingAccessEndPoller`,
`AccountOffboardingPurgeReminderPoller`, `EmailChannelReconcilePoller`,
`NotificationFailoverPoller` (already uses `resetModules`+dynamic import; sets
`ADMIN_NOTIFICATION_EMAIL` before each reset), `OutboxPoller` (no `OUTBOX_*` mutation
— relies on defaults). For these, the migrated reads hit the memoized default exactly
as the old `process.env` default branch did.

Every assertion in every converted test is preserved — only a `resetWorkerConfigForTests()`
line is added to `beforeEach` (and one mid-test for the double-mutation case).

## Baseline (`scripts/ci/process-env-baseline.ts`): 85 → 70 (−15)

**Removed (no remaining non-exempt/non-flag `process.env` read after migration):**
`AccountOffboardingAccessEndPoller.ts`, `AccountOffboardingPurgePoller.ts`,
`AccountOffboardingPurgeReminderPoller.ts`, `AccountOffboardingReactivationResetPoller.ts`,
`AccountOffboardingTeardownRetryPoller.ts`, `AnalyticsDispatchPoller.ts`,
`ArchivalPoller.ts`, `CancellationGracePoller.ts`, `EngagementMonitorPoller.ts`,
`HealthAlertPoller.ts`, `NotificationFailoverPoller.ts`, `OutboxPoller.ts`,
`billing-reconciliation/drift-alert.ts`, `health-alert/checks.ts`, `health-alert/emit.ts`.

**Stay in baseline (still read a Stage-4 flag):** `CleanupAbandonedSignupsPoller.ts`
(`SELF_SERVE_SIGNUP_ENABLED`), `EmailChannelReconcilePoller.ts`
(`EMAIL_CHANNEL_RECONCILE_DISABLED`), `StripeLocationsReconcilePoller.ts`
(`STRIPE_LOCATIONS_RECONCILE_DISABLED`), `ZernioRecentReviewPoller.ts`
(`ZERNIO_PUBLISHING_ENABLED` + `ZERNIO_RECENT_REVIEW_POLL_DISABLED`).

`AccountOffboardingPurgePoller.ts` drops despite still reading `NODE_ENV`/`VERCEL_ENV`
because those are exempt indicators (convention #2) — a file reading ONLY exempt
indicators + migrated vars has no counted read left.

The baseline is regenerated from the audit's own scan (do not hand-edit individual
entries beyond the removals); `pnpm ci:process-env` confirms the live scan matches.

## Tests added

- `src/lib/config/__tests__/worker.test.ts` — representative new vars
  present-when-set / `undefined`-when-unset via `getWorkerConfig()` (tolerate-absent,
  no throw), and `ADMIN_NOTIFICATION_EMAIL`/`SENTRY_DSN` whitespace `'   '`
  passthrough (rawOptionalVar, RED under collapsing `optionalVar`).
- Behavior-preservation spot-checks where a default/parse is non-trivial: covered
  by the existing poller tests (interval/batch default-on-unset, default-on-NaN,
  clamp), kept green with the memo-reset.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all must pass.

## Status / open risks
- Migrated: 34 distinct poller-tuning/alerting vars across 18 files onto
  `getWorkerConfig()`.
- Left as-is (reported): 5 Stage-4 flags, the exempt indicators.
- Module-level reads (OutboxPoller, HealthAlertPoller, emit.ts) moved to runtime —
  the only timing change, and it is behavior-equivalent because worker env is
  immutable after boot.
- The test-only `resetWorkerConfigForTests()` is the per-file test cost here; it is
  house-style (3 existing `*ForTests` precedents) and clears only the memo.
