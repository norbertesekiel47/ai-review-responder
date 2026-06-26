# Stage 3 BATCH — worker-jobs config migration

_Branch `refactor/audit-stage3-worker-jobs`. Migrates the `worker/jobs/**` raw
`process.env.*` reads onto the Stage-2 typed config accessors
(`src/lib/config/worker.ts`), following the Stage-3 conventions established by the
email pilot (`docs/superpowers/plans/2026-06-25-audit-stage3-pilot-email-config.md`),
the Stripe batch (`2026-06-25-audit-stage3-stripe-config.md`), and the
worker-pollers batch (`2026-06-25-audit-stage3-worker-pollers.md`)._

## Why this batch

`worker/jobs/**` is the next dense cluster of non-flag config reads in the
campaign: dashboard/approval URL building (`NEXT_PUBLIC_APP_URL` in 8 job files),
internal/owner-alert recipients (`ADMIN_NOTIFICATION_EMAIL`, `RESEND_FROM_EMAIL`),
the SerpAPI ranking key, a feedback-URL HMAC gate (`CSRF_SECRET`), the WhatsApp
auto-post FYI template (`WHATSAPP_AUTOPOST_TEMPLATE_SID`), and the Zernio ingest
pagination cap (`ZERNIO_INGEST_MAX_PAGES`). Every one of these is a worker-only
read (no Next-route consumer of these job handlers), so they ALL migrate to the
**worker lane** (`getWorkerConfig()`), never `getServerConfig()`.

**Hard rule (campaign-wide): ZERO PRODUCTION behavior change.** Every default,
fallback, truthy check, parse, and assert is preserved EXACTLY. Existing
worker-job tests pass unchanged in assertion; a test's env-setup *mechanism* is
refactored only where the memoized accessor requires it (convention #6 / the
worker-pollers `resetWorkerConfigForTests()` seam) — that is assertion-preserving
(runtime env is immutable, so a memoized snapshot equals a live read), not a
behavior change.

The Stage-3 conventions governing this batch (full text in the pilot plan):
- **#2** env-indicator exempt (`NODE_ENV`, `MOCK_EXTERNAL_APIS`, `VERCEL_*`) — stay direct.
- **#3** `*_ENABLED`/`*_DISABLED` flag-like toggles → Stage 4 — left untouched.
- **#4 (Stripe refinement)** worker-ONLY files use **`getWorkerConfig()`** (worker
  lane: self-loads dotenv, safe to call from a worker module at runtime). All
  job-handler files are worker-only, so all use `getWorkerConfig()`.
- **#5** tolerate-absent → optional schema field, NOT an asserting accessor.
- **#6** test-isolation: a test mutating a migrated var (in `beforeEach` or
  per-test, before the handler runs) needs the memo cleared via
  `resetWorkerConfigForTests()` (the worker-pollers seam).
- **#7** migrated RAW reads use `rawOptionalVar` (faithful `''`/`'   '`/unset passthrough).

### Convention #1 refinement — worker `NEXT_PUBLIC_APP_URL` reads ARE migrated

Convention #1 (pilot plan) exempts `NEXT_PUBLIC_*` reads: they stay
statically-inlined `process.env.NEXT_PUBLIC_X` because **Next.js inlines a public
var at build time** only for a statically-written `process.env.<LITERAL>` ref; a
dynamic `getClientConfig()[name]` lookup reads raw runtime env and can false-throw
on a deploy where the inlined app actually works.

**That hazard is Next-build-specific. The worker is NOT a Next build.** The Railway
worker runs under `tsx` (Node), so `process.env.NEXT_PUBLIC_APP_URL` inside a
`worker/jobs/**` handler is a **plain runtime env read** — Next's bundler never
touches it, there is no build-time inlining to break, and `NEXT_PUBLIC_APP_URL`
is supplied to the worker's runtime env on Railway exactly like any other var.
So routing it through `getWorkerConfig().NEXT_PUBLIC_APP_URL` (a runtime
`process.env` parse) is **behavior-identical** to the old raw read and carries
none of the inlining risk convention #1 guards against.

**Refinement (codified for the campaign): convention #1's `NEXT_PUBLIC_*`
exemption applies ONLY to code that Next bundles (browser components, Next server
routes/middleware that go through the Next build). Worker-lane (`tsx`) reads of a
`NEXT_PUBLIC_*` var are migrated to `getWorkerConfig().NEXT_PUBLIC_APP_URL` and
`NEXT_PUBLIC_APP_URL` is added to `workerSchema` as `rawOptionalVar`.** Each call
site's exact URL-building / fallback (`if (!appUrl) … fail`, `${appUrl}/dashboard`,
`appUrl.replace(/\/$/, '')`, `buildDashboardUrl(…, appUrl)`,
`buildKeepMyDataUrl(appUrl!, …)`) is preserved byte-for-byte. The `static-policy`
audit's `NEXT_PUBLIC_ACCESS` regex (`/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/`)
matches only the literal `process.env.NEXT_PUBLIC_*` form, so migrating away from
that literal removes the match entirely (and `NEXT_PUBLIC_APP_URL` is already in
`ALLOWED_NEXT_PUBLIC` regardless).

### SERPAPI decision — tolerate-read, NOT the asserting accessor

`worker/jobs/RankingTrackingWorker.ts:66` reads
`api_key: process.env.SERPAPI_API_KEY` inside `resolveRankPosition`, passing
whatever it gets straight to SerpAPI's `getJson(params)`. The entry handler
`handleTrackRanking` does **NOT** guard on key presence — there is no
`if (!key) throw` anywhere on this path. The job tolerate-reads the key (an absent
key would simply yield a SerpAPI auth error at call time, surfaced as a normal
job failure, not a config-boot throw).

Per convention #5 + key-decision #3: a **tolerate-absent** var is read via
`getWorkerConfig().SERPAPI_API_KEY` (→ `string | undefined`), preserving the
existing pass-through to the SDK. We do **NOT** use the asserting
`getWorkerSerpapiConfig()` — it would `throw` when the key is absent, introducing
a new throw where the code today does not. (Had this site asserted, it would have
been the asserting accessor's first real consumer; it does not, so the accessor
stays unwired.)

`SERPAPI_API_KEY` is already in `workerSchema` but as the **collapsing**
`optionalVar`. Because the migrated read is RAW (passes the value straight to the
SDK with no `?.trim()`), it is switched to `rawOptionalVar` (#7) so a whitespace-
only `'   '` reaches `new getJson({ api_key: '   ' })` exactly as the old raw read
did (the collapsing `optionalVar` would map `'   '`→`undefined`, changing the SDK
arg). The asserting `getWorkerSerpapiConfig()`/`assertWorkerSerpapiConfig()` are
UNAFFECTED — they test presence via `requirePresentIn`/`requirePresent`
(`value.trim().length === 0` ⇒ absent), so whitespace stays "absent" for the
asserting accessor regardless of the schema field.

## Scope — migrated vars (grouped by file)

All reads below become `getWorkerConfig().X` **inside the function body** (never at
module import), with the call site's fallback/assert preserved byte-for-byte.

| File | Migrated var(s) | Call-site behavior (preserved) |
|---|---|---|
| `AdminExceptionWorker.ts` | `ADMIN_NOTIFICATION_EMAIL` | `if (!adminEmail) { logger.error; markOutboxCompleted; return }` |
| `EngagementAlertWorker.ts` | `NEXT_PUBLIC_APP_URL`, `RESEND_FROM_EMAIL`, `ADMIN_NOTIFICATION_EMAIL` (×2) | each `if (!x) { … markOutboxFailed/Completed; return }` guard, exact reason strings |
| `MonthlyImpactWorker.ts` | `NEXT_PUBLIC_APP_URL` | `buildDashboardUrl(ownerHasDashboardAuth, appUrl)` — passes `string \| undefined` through |
| `WeeklySummaryWorker.ts` | `NEXT_PUBLIC_APP_URL`, `CSRF_SECRET` | `buildDashboardUrl(…, appUrl)`; `if (appUrl && cfg.CSRF_SECRET) { feedbackUrls = … }` truthy gate |
| `OnboardingDripWorker.ts` | `NEXT_PUBLIC_APP_URL` | `const dashboardUrl = ownerWithAuth && appUrl ? \`${appUrl}/dashboard\` : null` |
| `OwnerEmailWorker.ts` | `NEXT_PUBLIC_APP_URL` | `if (!appUrl) { … markOutboxFailed; return }; \`${appUrl}/dashboard/connect\`` |
| `RankingTrackingWorker.ts` | `SERPAPI_API_KEY` | `api_key: cfg.SERPAPI_API_KEY` passed raw to SerpAPI `getJson` (tolerate-read, no assert) |
| `account-offboarding/AccountOffboardingEmailWorker.ts` | `NEXT_PUBLIC_APP_URL` (×2) | `if (descriptor.needsKeepMyDataToken && !cfg.NEXT_PUBLIC_APP_URL) { markOutboxFailed; return }`; `buildKeepMyDataUrl(cfg.NEXT_PUBLIC_APP_URL!, token.rawToken)` (the `!` non-null assertion preserved — gated by the prior check) |
| `auto-post-notice/AutoPostNoticeWorker.ts` | `NEXT_PUBLIC_APP_URL` | `if (!appUrl) { … markOutboxFailed; return }; viewUrl = \`${appUrl.replace(/\/$/, '')}/r/google/${response_id}\`` |
| `auto-post-notice/dispatch.ts` | `WHATSAPP_AUTOPOST_TEMPLATE_SID` | `if (channelId === 'whatsapp' && !cfg.WHATSAPP_AUTOPOST_TEMPLATE_SID) { skip; continue }` |
| `notification/NotificationWorker.ts` | `NEXT_PUBLIC_APP_URL` | `if (!appUrl) { … markOutboxFailed; return }; appUrl passed into dispatchAll` |
| `zernio/ZernioReviewIngestWorker.ts` | `ZERNIO_INGEST_MAX_PAGES` | `Math.max(1, parseInt(cfg.ZERNIO_INGEST_MAX_PAGES ?? '4', 10) \|\| 4)` — default + NaN guard byte-for-byte |

### NOT migrated (left as-is, reported)

- **Flags → Stage 4:** `EDIT_REPLIES_ENABLED` (`publisher/ResponsePublisherWorker.ts`,
  `publisher/failed-hook.ts`), `CHANNELS_TELEGRAM_ENABLED` /
  `CHANNELS_WHATSAPP_ENABLED` (`notification/eligibility.ts`),
  `EXTERNAL_REPLY_IMPORT_ENABLED` (`zernio/zernio-ingest-shared.ts`),
  `AUTO_APPROVAL_ENABLED` / `OPENAI_MODERATION_ENABLED` (response-generation, read
  via shared helpers — not a direct `worker/jobs` read).
- **Env indicators (exempt #2):** `MOCK_EXTERNAL_APIS` (`ZernioReviewIngestWorker.ts:130`,
  `OnboardingDemoWorker.ts:55`), `NODE_ENV` (`OnboardingDemoWorker.ts:55`).
  `OnboardingDemoWorker.ts` reads ONLY exempt indicators → already absent from the
  baseline (dropped by the pilot's convention #2), untouched here.

## Schema changes (`src/lib/config/worker.ts`)

- **NEW `rawOptionalVar` fields (5):** `NEXT_PUBLIC_APP_URL`, `RESEND_FROM_EMAIL`,
  `CSRF_SECRET`, `WHATSAPP_AUTOPOST_TEMPLATE_SID`, `ZERNIO_INGEST_MAX_PAGES`. Each
  is a migrated raw read whose call site owns its own truthy/`!`/`parseInt` guard,
  so `rawOptionalVar` preserves `''`/`'   '`/unset byte-for-byte (#7).
- **`opt` → `rawOpt` switch (1):** `SERPAPI_API_KEY` was `optionalVar`; switched to
  `rawOptionalVar` because the migrated `RankingTrackingWorker` read passes it RAW
  to the SerpAPI SDK (no `?.trim()`), so `'   '` must survive (#7). The asserting
  `getWorkerSerpapiConfig()`/`assertWorkerSerpapiConfig()` are unaffected (they use
  `requirePresentIn`/`requirePresent`, whitespace-as-absent, independent of field).
- `ADMIN_NOTIFICATION_EMAIL` is ALREADY `rawOptionalVar` (worker-pollers batch) —
  its raw `if (!adminEmail)` reads in `AdminExceptionWorker`/`EngagementAlertWorker`
  are already byte-faithful; no change needed.
- `WORKER_REQUIRED_VARS` unchanged (all new fields optional) → `ci:config-coverage`
  unaffected (it only audits REQUIRED-var declarations).

## Test-only memo reset (`resetWorkerConfigForTests`)

`getWorkerConfig()` memoizes the first `process.env` parse. The migrated job-test
files set/delete a migrated var in `beforeEach` (and several per-test, BEFORE the
handler runs), then assert the worker's branch on that value. With a static import
+ memoized accessor, the first `getWorkerConfig()` call (in whatever test runs
first) would freeze the snapshot, so later mutations would not be seen. The
worker-pollers batch's `resetWorkerConfigForTests()` seam (already exported from
`worker.ts`) clears the memo so the next `getWorkerConfig()` re-parses the current
`process.env`.

Because every per-test env mutation happens **before** the `await handle…()` call
(and the handler is the first thing to call `getWorkerConfig()`), a single
`resetWorkerConfigForTests()` at the end of each file's `beforeEach` suffices — the
memo is cleared, then re-populates lazily on the handler's first read, which is
after all of that test's mutations. Every assertion is preserved; only a
`resetWorkerConfigForTests()` line is added.

**Converted `beforeEach` (one line added each):**
- `worker/jobs/__tests__/AdminExceptionWorker.test.ts` (`ADMIN_NOTIFICATION_EMAIL`)
- `worker/jobs/__tests__/EngagementAlertWorker.test.ts` (`NEXT_PUBLIC_APP_URL`,
  `RESEND_FROM_EMAIL`, `ADMIN_NOTIFICATION_EMAIL` — incl. per-test `delete`s)
- `worker/jobs/__tests__/MonthlyImpactWorker.test.ts` (`NEXT_PUBLIC_APP_URL`)
- `worker/jobs/__tests__/WeeklySummaryWorker.test.ts` (`NEXT_PUBLIC_APP_URL`)
- `worker/jobs/__tests__/OnboardingDripWorker.test.ts` (`NEXT_PUBLIC_APP_URL`)
- `worker/jobs/__tests__/RankingTrackingWorker.test.ts` (`SERPAPI_API_KEY`, set in
  `beforeEach` / deleted in `afterEach` — reset added to `beforeEach`)
- `worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts`
  (`ZERNIO_INGEST_MAX_PAGES` — one test sets `'2'` then restores in `finally`; a
  reset is added in `beforeEach`, and the seam is invoked around the mid-test
  override so the `'2'` read and the restored-default read both hold)
- `worker/jobs/notification/__tests__/*` (NotificationWorker + variants),
  `worker/jobs/account-offboarding/__tests__/AccountOffboardingEmailWorker.test.ts`,
  `worker/jobs/auto-post-notice/__tests__/dispatch.test.ts` — converted where the
  file sets/deletes a migrated var that the handler then branches on.

The conversion is mechanical and assertion-preserving — a memoized snapshot of an
immutable runtime env equals a live read, so production behavior is identical.

## Baseline (`scripts/ci/process-env-baseline.ts`): 70 → 58 (−12)

**Removed (no remaining non-exempt/non-flag `process.env` read after migration):**
`worker/jobs/AdminExceptionWorker.ts`, `worker/jobs/EngagementAlertWorker.ts`,
`worker/jobs/MonthlyImpactWorker.ts`, `worker/jobs/OnboardingDripWorker.ts`,
`worker/jobs/OwnerEmailWorker.ts`, `worker/jobs/RankingTrackingWorker.ts`,
`worker/jobs/WeeklySummaryWorker.ts`,
`worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts`,
`worker/jobs/auto-post-notice/AutoPostNoticeWorker.ts`,
`worker/jobs/auto-post-notice/dispatch.ts`,
`worker/jobs/notification/NotificationWorker.ts`,
`worker/jobs/zernio/ZernioReviewIngestWorker.ts` (also reads `MOCK_EXTERNAL_APIS`,
exempt #2, so no counted read remains).

**Stay in baseline (still read a Stage-4 flag):**
`worker/jobs/notification/eligibility.ts` (`CHANNELS_*_ENABLED`),
`worker/jobs/publisher/ResponsePublisherWorker.ts` (`EDIT_REPLIES_ENABLED`),
`worker/jobs/publisher/failed-hook.ts` (`EDIT_REPLIES_ENABLED`),
`worker/jobs/zernio/zernio-ingest-shared.ts` (`EXTERNAL_REPLY_IMPORT_ENABLED`).

The baseline is regenerated from the audit's own live scan (the removals above);
`pnpm ci:process-env` confirms the live scan matches the committed baseline.

## Tests added

- `src/lib/config/__tests__/worker.test.ts` — the 5 new vars + the switched
  `SERPAPI_API_KEY` present-when-set / `undefined`-when-unset via `getWorkerConfig()`
  (tolerate-absent, no throw), and a whitespace `'   '` passthrough on
  `SERPAPI_API_KEY` / `NEXT_PUBLIC_APP_URL` (rawOptionalVar #7; RED under the
  collapsing `optionalVar`).
- Behavior-preservation spot-checks for the two non-trivial fallbacks:
  - `NEXT_PUBLIC_APP_URL` default/guard: covered by the existing worker tests'
    `if (!appUrl) { markOutboxFailed }` cases (e.g. EngagementAlert/Notification/
    OwnerEmail/AutoPostNotice), kept green with the memo-reset.
  - `ZERNIO_INGEST_MAX_PAGES` `?? '4' || 4` default-on-unset + NaN guard: covered
    by `ZernioReviewIngestWorker.test.ts`'s `'2'`-override and default cases.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all must pass.

## Status / open risks
- Migrated: 6 distinct vars (`NEXT_PUBLIC_APP_URL`, `RESEND_FROM_EMAIL`,
  `ADMIN_NOTIFICATION_EMAIL`, `SERPAPI_API_KEY`, `CSRF_SECRET`,
  `WHATSAPP_AUTOPOST_TEMPLATE_SID`, `ZERNIO_INGEST_MAX_PAGES` — 7 counting
  `ADMIN_NOTIFICATION_EMAIL` which was already in-schema) across 12 job files onto
  `getWorkerConfig()`.
- Left as-is (reported): the Stage-4 flags in the 4 baseline-retained files, the
  exempt indicators.
- Convention #1 refinement (worker `NEXT_PUBLIC_*` migrated) is the new campaign
  rule this batch establishes — documented above for downstream batches.
- The SERPAPI tolerate-read confirms the worker-pollers/Stripe finding: the
  asserting subsystem accessors (`getWorkerSerpapiConfig` here) remain unwired
  because no real call site wants their all-or-nothing assert.
