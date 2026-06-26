# Stage 3 BATCH — SerpAPI + Redis cluster config migration

_Branch `refactor/audit-stage3-serpapi-redis`. Migrates the SerpAPI + Redis
review-ingestion cluster's raw `process.env.*` reads onto the Stage-2 typed config
accessors (`src/lib/config/{server,worker}.ts`), following the conventions
established by the email pilot (`2026-06-25-audit-stage3-pilot-email-config.md`)
and the src-lib / worker-pollers / worker-jobs / worker-ingress batches. This is
the coherent follow-up the src-lib batch explicitly deferred ("SerpAPI + Redis
presence cluster — migrate together for one `REDIS_CACHE_URL` + SerpAPI decision")._

**Hard rule (campaign-wide): ZERO PRODUCTION behavior change.** Every default,
fallback, truthy check, parse, trim, and throw is preserved byte-for-byte. Every
existing behavior **assertion** is preserved; a test's env-setup *mechanism* is
refactored only where the memoized accessor requires it (convention #6).

## Why this is ONE coherent batch

The three files share the `REDIS_CACHE_URL` presence-gate decision and two of them
share `SERPAPI_API_KEY`. The src-lib batch deferred them precisely so the
`REDIS_CACHE_URL` switch (`opt` → `rawOpt`) and the `SERPAPI_TIMEOUT_MS`
module-level→in-fn move could be reasoned about together, across both lanes, in a
single change. `REDIS_CACHE_URL` was shape-only/unconsumed before this batch (the
`db/redis-cache.ts` constructor reads `process.env` directly and is allowlisted),
so the `opt`→`rawOpt` switch has exactly these three new consumers and no other.

## Conventions applied (full text in the pilot plan)
- **#1** `NEXT_PUBLIC_*` reads in Next-bundled code stay literal (none migrated here).
- **#2** env indicators (`NODE_ENV`, `MOCK_EXTERNAL_APIS`, `VERCEL_*`) exempt — stay
  direct. `serpapi-prefill.ts`'s `isMockMode()` reads `MOCK_EXTERNAL_APIS` in a
  different (already-exempt) module; untouched.
- **#3** `*_ENABLED`/`*_DISABLED` flags → Stage 4 — none here.
- **#4** lane: shared dual-runtime `src/lib` modules read via `getServerConfig()`;
  worker-only modules read via `getWorkerConfig()` (self-loads dotenv). Every read
  is invoked at RUNTIME inside a function (never at module import — the
  runtime-invocation constraint).
- **#5** tolerate-absent / own-throw var → optional schema field + keep the call
  site's own gate/throw; no asserting accessor is introduced.
- **#6** test-isolation: a test that mutates a migrated var mid-file clears the memo
  (`resetServerConfigForTests()` / `resetWorkerConfigForTests()`) after the mutation
  so the next accessor call re-parses; every assertion preserved.
- **#7** migrated RAW reads use `rawOptionalVar` (faithful `''`/`'   '`/unset
  passthrough) — the most-bitten gotcha: the presence gates (`if (!REDIS_CACHE_URL)`)
  and the api-key guard (`if (!apiKey)`) depend on the RAW string surviving; the
  collapsing `optionalVar` would map a whitespace `'   '` to undefined and FLIP the
  gate.
- **#9** worker-lane test hermeticity: stub `@/lib/config/dotenv-load` so a real
  `.env.local` can't repopulate a var the test deliberately deletes (used by the
  place-id-resolver fail-closed test).

## The 3 files — lane decisions + WHY

| File | Lane | Accessor | Importers (why) |
|---|---|---|---|
| `reviews/serpapi-prefill.ts` | **Next-only** | `getServerConfig()` | Imported ONLY by `api/signup/place-prefill/route.ts` + `api/admin/businesses/prefill/route.ts` (Next server routes). |
| `reviews/place-id-resolver.ts` | **worker-only** | `getWorkerConfig()` | Imported ONLY by `worker/jobs/*` (DemoGenerationWorker, PlaceIdValidationWorker, RankingTrackingWorker, onboarding-demo/place-resolution). Worker-only → `getWorkerConfig()` self-loads dotenv (#4); vitest.setup.ts provides the 4 worker-required vars so the parse won't throw in tests. |
| `shared/rate-limit.ts` | **dual (Next + worker)** | `getServerConfig()` | Imported by both Next routes (auth, onboarding, contact, analytics, …) AND the worker (RankingTrackingWorker strict mode, `ingress/rate-limit`). Dual-runtime shared `src/lib` → `getServerConfig()` (#4); the read is in-fn (called at request/job time, after worker boot dotenv), so the runtime-invocation constraint is satisfied. |

## Schema changes

### `src/lib/config/server.ts`
- `SERPAPI_API_KEY: opt` → **`SERPAPI_API_KEY: rawOpt`**. `serpapi-prefill.ts` does
  `const apiKey = getServerConfig().SERPAPI_API_KEY; if (!apiKey)` on the RAW value
  (#7); `place-id-resolver` passes it straight to the SerpAPI SDK.
  `getSerpapiConfig`/`assertSerpapiConfig` still treat whitespace as absent via
  `requirePresentIn`/`requirePresent`, so the asserting accessor is unaffected.
- `REDIS_CACHE_URL: opt` → **`REDIS_CACHE_URL: rawOpt`**. The presence gates do
  `if (!getServerConfig().REDIS_CACHE_URL)` (serpapi-prefill readCache/writeCache,
  rate-limit), so `rawOptionalVar` keeps `'   '` TRUTHY exactly like the old raw
  `process.env.REDIS_CACHE_URL` — the collapsing `opt` would FLIP the gate (skip
  cache / wrongly fail-closed). Shape-only/unconsumed before this batch.
- ADD **`SERPAPI_TIMEOUT_MS: rawOpt`** (new). serpapi-prefill computes
  `cfg.SERPAPI_TIMEOUT_MS ? Math.max(1, parseInt(cfg.SERPAPI_TIMEOUT_MS, 10)) :
  2_000`, so `rawOptionalVar` preserves `''`/`'   '`/unset byte-for-byte (#7).

### `src/lib/config/worker.ts`
- `REDIS_CACHE_URL: opt` → **`REDIS_CACHE_URL: rawOpt`**. `place-id-resolver.ts`
  (worker-only) does `if (!getWorkerConfig().REDIS_CACHE_URL)` fail-closed gate;
  `rawOptionalVar` keeps `'   '` truthy (#7). `startup-assert.ts` reads
  `process.env` directly so boot semantics are unchanged.
- `SERPAPI_API_KEY` is ALREADY `rawOpt` in worker.ts (Stage-3 worker-jobs batch) —
  left unchanged.

No new REQUIRED var → `WORKER_REQUIRED_VARS`/`CORE_APP_REQUIRED_VARS` unchanged →
`ci:config-coverage` (audits REQUIRED declarations only) unaffected. No asserting
accessor is added or wired (every migrated site keeps its own gate, #5).

## Per-file before → after

| File | Var | Before → After / why |
|---|---|---|
| `reviews/serpapi-prefill.ts` | `SERPAPI_TIMEOUT_MS` | **Module-level → in-fn.** Removed `const SERPAPI_TIMEOUT_MS = process.env.SERPAPI_TIMEOUT_MS ? Math.max(1, parseInt(...)) : 2_000` (top-level). Inside `fetchBusinessDetails`, after the api-key guard, `const serpApiTimeoutMs = cfg.SERPAPI_TIMEOUT_MS ? Math.max(1, parseInt(cfg.SERPAPI_TIMEOUT_MS, 10)) : 2_000`. Both race usages (`reject(new Error(\`SerpAPI timeout after ${serpApiTimeoutMs}ms\`))` + `setTimeout(…, serpApiTimeoutMs)`) updated. The explanatory comment (2s default / staging override) moved to the in-fn computation. The `Math.max(1, parseInt(raw, 10))` and `: 2_000` default preserved EXACTLY. Moving the read into the function is REQUIRED by #4 (the module-level read would otherwise force an import-time `getServerConfig()` parse — the src-lib batch's stated reason for deferral). |
| `reviews/serpapi-prefill.ts` | `SERPAPI_API_KEY` | `const apiKey = process.env.SERPAPI_API_KEY` → `const cfg = getServerConfig(); const apiKey = cfg.SERPAPI_API_KEY`. `if (!apiKey) { console.warn(...); return emptyPrefill(); }` unchanged. |
| `reviews/serpapi-prefill.ts` | `REDIS_CACHE_URL` | `readCache`/`writeCache`: `if (!process.env.REDIS_CACHE_URL)` → `if (!getServerConfig().REDIS_CACHE_URL)`. Gate semantics byte-for-byte. |
| `reviews/place-id-resolver.ts` | `SERPAPI_API_KEY` | `api_key: process.env.SERPAPI_API_KEY` → `api_key: getWorkerConfig().SERPAPI_API_KEY` (raw SDK arg, no presence assert). The hardcoded `const SERPAPI_TIMEOUT_MS = 12_000` (a constant, NOT an env read) is left untouched. |
| `reviews/place-id-resolver.ts` | `REDIS_CACHE_URL` | `checkSerpApiResolutionBudget`: `if (!process.env.REDIS_CACHE_URL) { throw … }` → `if (!getWorkerConfig().REDIS_CACHE_URL) { …same throw… }`. Fail-closed gate unchanged. |
| `shared/rate-limit.ts` | `REDIS_CACHE_URL` | `if (!process.env.REDIS_CACHE_URL) {` → `if (!getServerConfig().REDIS_CACHE_URL) {`. The strict-throw / fail-open-return branch preserved EXACTLY. |

## Test conversions (convention #6 — every assertion preserved; only env-setup changes)

| Test file | Lane | Conversion |
|---|---|---|
| `reviews/__tests__/serpapi-prefill.test.ts` | `getServerConfig()` | Import `resetServerConfigForTests`. `beforeEach` calls it AFTER setting `SERPAPI_API_KEY` + `REDIS_CACHE_URL` so the memo re-parses per-test. The "skips cache entirely when REDIS_CACHE_URL is not set" (`delete REDIS_CACHE_URL`) and "returns all-null when SERPAPI_API_KEY is not set" (`delete SERPAPI_API_KEY`) tests call `resetServerConfigForTests()` immediately after the `delete`. All 30+ assertions identical. |
| `reviews/__tests__/place-id-resolver.test.ts` | `getWorkerConfig()` | Top-level `vi.mock('@/lib/config/dotenv-load', …)` no-op (convention #9 — the fail-closed test relies on `REDIS_CACHE_URL` being ABSENT; stub the loader so a real `.env.local` can't repopulate it). Import `resetWorkerConfigForTests`; `beforeEach` calls it after setting `REDIS_CACHE_URL`. The "blocks when REDIS_CACHE_URL is not set (fail closed)" test resets after the delete. place-id-resolver now also reads `SERPAPI_API_KEY` via `getWorkerConfig()` — the existing tests mock `serpapi.getJson`, so the api_key value doesn't affect assertions; the dotenv stub + vitest.setup's 4 required vars keep the parse clean. |
| `shared/__tests__/rate-limit.test.ts` | `getServerConfig()` | Import `resetServerConfigForTests`; `beforeEach` calls it after setting `REDIS_CACHE_URL`. The two `delete REDIS_CACHE_URL` tests ("throws … in strict mode", "allows … in default mode") reset after the delete. Both assertions identical. |

### Added behavior-lock tests (TDD)
- `src/lib/config/__tests__/server.test.ts` — the 3 changed/new fields preserve raw
  passthrough: `SERPAPI_API_KEY` / `REDIS_CACHE_URL` / `SERPAPI_TIMEOUT_MS` set to
  whitespace-only `'   '` survive as `'   '` (NOT collapsed to undefined), and
  unset → undefined. RED under the collapsing `optionalVar`, GREEN under
  `rawOptionalVar`.
- `src/lib/config/__tests__/worker.test.ts` — the same `REDIS_CACHE_URL`
  whitespace-passthrough + unset-undefined lock for the worker lane.

## Baseline (`scripts/ci/process-env-baseline.ts`): 42 → 39 (−3)
**Removed (fully migrated, no remaining counted read; no import-time reader → not
allowlisted):** `src/lib/reviews/place-id-resolver.ts`,
`src/lib/reviews/serpapi-prefill.ts`, `src/lib/shared/rate-limit.ts`. The baseline
is regenerated from the audit's own live scan; `pnpm ci:process-env` confirms the
live scan matches the committed baseline (39).

## Deferred (unchanged — still in baseline)
- `costs/tracker.ts` — CRITICAL cost guard, dynamic-key `*_CENTS` reads (LEAVE).
- `zernio/client/transport.ts` — Zernio transport + mock knob.
- the notification channel cluster, `payments/*`, the Stage-4 `*_ENABLED` flag homes.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all must pass.

## Open risks
- The `SERPAPI_TIMEOUT_MS` module-level→in-fn move is the only structural change
  (vs a pure read swap). It is behavior-faithful: the value is read once per
  `fetchBusinessDetails` call (after the memoized first parse) instead of once at
  import — identical at runtime because env is immutable. The 2s timeout regression
  tests ("returns empty prefill if SerpAPI call exceeds timeout", "records
  api_costs row even when SerpAPI times out") still exercise the default path.
