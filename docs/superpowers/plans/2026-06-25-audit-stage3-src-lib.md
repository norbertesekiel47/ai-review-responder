# Stage 3 BATCH — `src/lib/**` config migration (server/shared secrets + foundational allowlist)

_Branch `refactor/audit-stage3-src-lib`. Migrates a coherent sub-batch of the
`src/lib/**` raw `process.env.*` reads onto the Stage-2 typed config accessors
(`src/lib/config/server.ts`), following the conventions established by the email
pilot (`2026-06-25-audit-stage3-pilot-email-config.md`), the Stripe batch
(`…-stripe-config.md`), and the worker-pollers / worker-jobs / worker-ingress
batches. Adds the foundational module-load readers to the `process-env`
allowlist rather than forcing an import-time parse._

## Why this is SCOPED to a sub-batch (not the whole `src/lib` set)

The full non-NEXT_PUBLIC / non-indicator / non-flag `src/lib` reader set is ~20
files spanning CRITICAL (the cost-reservation guard) and FOUNDATIONAL
(import-time client/singleton constructors) pieces. The task sizing rule caps a
batch at ~18 changed source files and says a correct partial beats a risky big
one. This batch takes the **clearly-server/shared secrets + small config
readers + the foundational allowlist additions** — the low-risk, high-confidence
core — and **explicitly defers** the entangled remainder (cost-guard, mock-knob
transport, Redis-presence gates, lane-ambiguous notification channels) to a
follow-up. Every deferred file is named in "Deferred" below.

**Hard rule (campaign-wide): ZERO PRODUCTION behavior change.** Every default,
fallback, truthy check, parse, trim, and throw is preserved byte-for-byte.
Existing tests pass unchanged in assertion; a test's env-setup *mechanism* is
refactored only where the memoized accessor requires it (convention #6).

## Conventions applied (full text in the pilot plan)
- **#1** `NEXT_PUBLIC_*` reads in Next-bundled code stay literal (none migrated here).
- **#2** env indicators (`NODE_ENV`, `MOCK_EXTERNAL_APIS`, `VERCEL_*`) exempt — stay direct.
- **#3** `*_ENABLED`/`*_DISABLED` flags → Stage 4 — left untouched.
- **#4** shared dual-runtime `src/lib` modules read via **`getServerConfig()`**,
  invoked at RUNTIME inside a function (never at module import — the worker loads
  dotenv at boot *before* any handler runs but *after* module import, and
  `getServerConfig()` does not self-load dotenv).
- **#5** tolerate-absent / own-throw var → optional schema field + keep the call
  site's own fallback/throw; do NOT introduce an asserting accessor that would
  throw where the code already throws its own typed error.
- **#6** test-isolation: a test that mutates a migrated var mid-file needs
  `vi.resetModules()` + dynamic re-import so the memo re-parses.
- **#7** migrated RAW reads use `rawOptionalVar` (faithful `''`/`'   '`/unset passthrough).

## Categorization — EVERY non-NEXT_PUBLIC / non-indicator `src/lib` reader

| File | Var(s) | Category | Decision / why |
|---|---|---|---|
| `db/server.ts` | `DATABASE_POOL_URL`, `DB_POOL_MAX`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | **ALLOWLIST** | Top-level `postgres(...)` + `createClient(...)` at MODULE LOAD; migrating forces an import-time `getServerConfig()` parse. Foundational. |
| `db/redis-cache.ts` | `REDIS_CACHE_URL`, `REDIS_CACHE_TOKEN` | **ALLOWLIST** | `getCacheRedisOptions()` constructs the ioredis client; the `url!` non-null + `url.startsWith` is the singleton constructor. Foundational config home. |
| `demos/fetch-reviews.ts` | `SERPAPI_API_KEY` | **ALLOWLIST** | Read at MODULE TOP-LEVEL (`const serpApiKey = …`) with a module-load fail-fast `throw`. Migrating forces an import-time parse. Foundational. (`MOCK_EXTERNAL_APIS` exempt #2.) |
| `admin/cost-report-service.ts` | `DAILY_COST_LIMIT_CENTS_*`, `GLOBAL_DAILY_COST_LIMIT_CENTS` | **ALLOWLIST** | `*_CENTS` cost limits read at MODULE TOP-LEVEL to build `const TIER_LIMITS_CENTS` / `const GLOBAL_DAILY_LIMIT_CENTS`. CRITICAL cost-limit care + import-time parse → allowlist, leave byte-for-byte. |
| `shared/logger.ts` | `LOG_SERVICE` | **ALLOWLIST** | Imported by 93 modules ultra-early; foundational hot path. Only non-exempt read is `LOG_SERVICE` (a tolerate-absent `?? 'worker'` label); `NODE_ENV` exempt #2. Routing the universal logger through `getServerConfig()` risks an import cycle and adds a memoized parse to the lowest-level utility. Allowlist as a config-adjacent foundational reader. |
| `costs/tracker.ts` | `GLOBAL_DAILY_COST_LIMIT_CENTS`, `DAILY_COST_LIMIT_CENTS_<tier>` (dynamic key) | **LEAVE + report (CRITICAL)** | The spend-safety cost-reservation guard (architecture invariant). `getTierLimitCents` reads `process.env[\`DAILY_COST_LIMIT_CENTS_${suffix}\`]` — a DYNAMIC key that has no clean static schema field. Cannot be made byte-for-byte equivalent without risk → LEAVE the parse/compare/default exactly, report, defer. Stays in baseline. |
| `zernio/client/transport.ts` | `ZERNIO_API_BASE`, `ZERNIO_API_KEY`, `MOCK_ZERNIO_LOCATION_COUNT` | **DEFER** | `ZERNIO_API_BASE`/`ZERNIO_API_KEY` are genuine runtime config (migratable), but `MOCK_ZERNIO_LOCATION_COUNT` is a mock-only test knob (read only inside `mockLocations()`, reached only in `MOCK_EXTERNAL_APIS` mode). Migrating the two config vars would NOT remove the file from the baseline (the mock knob is a counted non-exempt read), so the file stays in baseline regardless — defer the whole file to the follow-up that also classifies the mock knob (treat-as-indicator vs migrate). `MOCK_EXTERNAL_APIS` exempt #2. |
| `reviews/serpapi-prefill.ts` | `SERPAPI_TIMEOUT_MS` (module-level), `SERPAPI_API_KEY`, `REDIS_CACHE_URL` | **DEFER** | `SERPAPI_TIMEOUT_MS` is read at MODULE TOP-LEVEL (`const SERPAPI_TIMEOUT_MS = …`); migrating it forces an import-time parse, and the Redis-presence gate couples to the rate-limit/place-id Redis cluster. Defer the SerpAPI+Redis cluster as one coherent follow-up. |
| `reviews/place-id-resolver.ts` | `SERPAPI_API_KEY`, `REDIS_CACHE_URL` | **DEFER** | Same SerpAPI+Redis-presence cluster as `serpapi-prefill.ts`; migrate together. |
| `shared/rate-limit.ts` | `REDIS_CACHE_URL` | **DEFER** | `if (!process.env.REDIS_CACHE_URL)` presence gate — part of the Redis-presence cluster (`place-id-resolver`, `serpapi-prefill`); migrate together for one coherent `REDIS_CACHE_URL` decision. |
| `notifications/channels/email-channel.ts` | `RESEND_FROM_EMAIL` | **DEFER** | Notification-channel cluster; lane (worker+server) + co-resident `CHANNELS_*_ENABLED` flags in sibling files. Defer the channel cluster as one batch. |
| `notifications/channels/telegram-client.ts` | `TELEGRAM_BOT_TOKEN` | **DEFER** | Default-param read in constructor; channel cluster. |
| `notifications/channels/whatsapp-client.ts` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` | **DEFER** | Channel cluster. |
| `notifications/channels/whatsapp-channel.ts` | `WHATSAPP_AUTOPOST_TEMPLATE_SID` | **DEFER** | Channel cluster. |
| `notifications/channels/whatsapp-body.ts` | `WHATSAPP_APPROVAL_TEMPLATE_SID`, `WHATSAPP_AUTOPOST_TEMPLATE_SID` | **DEFER** | Default-param reads (call-time); channel cluster. |
| `notifications/channels/index.ts` | `CHANNELS_TELEGRAM_ENABLED`, `CHANNELS_WHATSAPP_ENABLED` | **DEFER-FLAG (#3)** | Stage-4 flags only — stays in baseline. |
| `payments/create-checkout-session.ts` | `TRIAL_PERIOD_DAYS` (+ `NEXT_PUBLIC_APP_URL`, `STRIPE_TAX_ENABLED`) | **DEFER** | `TRIAL_PERIOD_DAYS` is migratable, but the file also reads `NEXT_PUBLIC_APP_URL` (literal #1, Next-bundled route) and `STRIPE_TAX_ENABLED` (flag #3), so it STAYS in baseline regardless. Defer with the payments cluster. |
| `auto-approval/flags.ts` | `AUTO_APPROVAL_PROVIDER_MODERATION_READY`, `AUTO_APPROVAL_ENABLED`, `OPENAI_MODERATION_ENABLED`, `VERCEL_TARGET_ENV` | **DEFER-FLAG (#3)** | Flag home → Stage 4. Leave. |
| `admin/business-detail/mappers.ts`, `channels/override.ts`, `locations/owner-route.ts`, `moderation/moderate.ts`, `past-replies/flags.ts`, `onboarding/admin-onboarding-service.ts`, `shared/csrf.ts`, `payments/payment-link.ts`, `auth/require-owner-access.ts`, `db/auth.ts`, `db/browser.ts` | various | **DEFER / FLAG / NEXT_PUBLIC** | Flags (`*_ENABLED`), `NEXT_PUBLIC_*` literals (#1), or other clusters — out of this sub-batch's scope. |
| **`admin/impersonation/cookie.ts`** | `IMPERSONATION_COOKIE_SECRET` | **MIGRATE** | Lazy read in `getSecret()` with own `throw`. → `getServerConfig()`, keep throw (#5). |
| **`analytics/posthog.ts`** | `POSTHOG_API_KEY`, `POSTHOG_HOST` | **MIGRATE** | Lazy reads in `getPostHogClient()` / `isAnalyticsConfigured()`. → `getServerConfig()` (#5, tolerate-absent). |
| **`costs/onboarding-demo-cost-guard.ts`** | `ONBOARDING_DEMO_DAILY_CENTS` | **MIGRATE** | Lazy read in `resolveCeilingCents()` (tolerate-absent, has default). → `getServerConfig()`. NOT the CRITICAL post-pay cost guard (distinct pre-pay demo lane). |
| **`google/owner-leads-sheet.ts`** | `OWNER_LEADS_GOOGLE_SHEET_ID`, `GOOGLE_SHEETS_CLIENT_EMAIL`, `GOOGLE_SHEETS_PRIVATE_KEY`, `OWNER_LEADS_GOOGLE_SHEET_RANGE` | **MIGRATE** | Lazy reads in `readConfig()` (own `?.trim()`/throw chain). → `getServerConfig()` (#7 raw). |
| **`shared/feedback-hmac.ts`** | `CSRF_SECRET` | **MIGRATE** | Lazy read in `getSecret()` with own `throw`. → `getServerConfig()`, keep throw. |
| **`shared/session-cookie-secret.ts`** | `SESSION_COOKIE_SECRET` | **MIGRATE** | Lazy read in `getSessionCookieSecret()` with own throw + byte-length check. → `getServerConfig()`, keep both throws. |
| **`shared/worker-public-url.ts`** | `WORKER_PUBLIC_URL` | **MIGRATE** | Lazy read in `getWorkerPublicUrl()` with own throw + `new URL().origin`. → `getServerConfig()`, keep throw + normalization. |

### Lane decision for the 7 MIGRATE files: `getServerConfig()`
All 7 run in BOTH the Railway worker and Next server routes (e.g. `cookie.ts` is
imported by client components AND `zernio/connect-session-cookie.ts`;
`feedback-hmac` by `WeeklySummaryWorker` + the Next `/api/feedback` route;
`posthog` by `worker/index.ts` + `src/lib/analytics/activation-event.ts`;
`worker-public-url` by a Twilio ingress + the WhatsApp channel). Per convention
#4 a shared dual-runtime module reads through `getServerConfig()`, and every read
is already INSIDE a function (runtime-invocation constraint satisfied), so the
worker memo first populates after `worker/env.ts` loads dotenv — never empty.

## Schema additions (`src/lib/config/server.ts`)
All new fields are **`rawOptionalVar`** (#7) — each migrated read either passes
the value to its own `?.trim()`/`!value`/`Boolean()`/throw, so `''`/`'   '`/unset
must survive byte-for-byte:
- `IMPERSONATION_COOKIE_SECRET` — already declared `optionalVar` in the Stage-2
  shape-only schema; **switch to `rawOptionalVar`** (the `getSecret()` read does
  `if (!value)` then a `.length < 32` check on the RAW value — a whitespace
  secret must reach the length check, not collapse to undefined).
- `SESSION_COOKIE_SECRET`, `CSRF_SECRET` — already declared `optionalVar` in the
  Stage-2 schema; **switch to `rawOptionalVar`** (each does `if (!secret) throw`
  then a raw `Buffer.byteLength`/HMAC on the raw value).
- `WORKER_PUBLIC_URL` — already `optionalVar`; **switch to `rawOptionalVar`**
  (`if (!raw) throw; new URL(raw)` consumes the raw string).
- `POSTHOG_API_KEY`, `POSTHOG_HOST` — **NEW** `rawOptionalVar`.
- `ONBOARDING_DEMO_DAILY_CENTS` — **NEW** `rawOptionalVar`.
- `OWNER_LEADS_GOOGLE_SHEET_ID`, `GOOGLE_SHEETS_CLIENT_EMAIL`,
  `GOOGLE_SHEETS_PRIVATE_KEY`, `OWNER_LEADS_GOOGLE_SHEET_RANGE` — **NEW**
  `rawOptionalVar`.

No new REQUIRED var → `WORKER_REQUIRED_VARS`/`CORE_APP_REQUIRED_VARS` unchanged →
`ci:config-coverage` (audits REQUIRED declarations only) unaffected. No asserting
accessor is added or wired (every migrated site keeps its own throw, #5).

## Cost-guard preservation confirmation
- **`costs/tracker.ts` — UNTOUCHED.** `getTierLimitCents` / `getGlobalLimitCents` /
  `safeParseLimitCents` and the dynamic `process.env[\`DAILY_COST_LIMIT_CENTS_…\`]`
  read are left exactly as-is (LEAVE-and-report; the dynamic key has no clean
  static schema field, and this is the spend-safety invariant). Stays in baseline.
- **`admin/cost-report-service.ts` — UNTOUCHED (allowlisted).** The `*_CENTS`
  module-level limit constants (`safeLimit(process.env.DAILY_COST_LIMIT_CENTS_*)`,
  `safeLimit(process.env.GLOBAL_DAILY_COST_LIMIT_CENTS)`) are preserved
  byte-for-byte; the file is added to the allowlist (import-time read).
- `costs/onboarding-demo-cost-guard.ts` is the **pre-pay demo** lane (distinct
  from the post-pay cost guard) — its `ONBOARDING_DEMO_DAILY_CENTS` migration
  preserves the Redis-override-first → env → `DEFAULT_DAILY_CENTS` precedence and
  the `Number.isFinite && > 0` guard exactly.

## Allowlist additions (`scripts/ci/process-env-baseline.ts`)
Add to `ALLOWLIST_FILES` (sanctioned `process.env` homes — import-time
client/singleton/limit constructors that a config accessor cannot replace without
forcing a module-load parse), each with an inline rationale:
- `src/lib/db/server.ts`
- `src/lib/db/redis-cache.ts`
- `src/lib/demos/fetch-reviews.ts`
- `src/lib/admin/cost-report-service.ts`
- `src/lib/shared/logger.ts`

## Baseline delta (`PROCESS_ENV_BASELINE`)
**Removed (fully migrated, no remaining counted read):** `admin/impersonation/cookie.ts`,
`analytics/posthog.ts`, `costs/onboarding-demo-cost-guard.ts`,
`google/owner-leads-sheet.ts`, `shared/feedback-hmac.ts`,
`shared/session-cookie-secret.ts`, `shared/worker-public-url.ts` (7).
**Moved baseline → allowlist:** `db/server.ts`, `db/redis-cache.ts`,
`demos/fetch-reviews.ts`, `admin/cost-report-service.ts`, `shared/logger.ts` (5).
**Stay in baseline (deferred / flag / cost-guard):** everything else, incl.
`costs/tracker.ts`, `zernio/client/transport.ts`, the SerpAPI+Redis cluster, the
channel cluster, `payments/create-checkout-session.ts`, the flag homes.

Net `PROCESS_ENV_BASELINE`: 88 → 76 (−12: 7 migrated + 5 allowlisted). The
baseline is regenerated from the audit's own live scan; `pnpm ci:process-env`
confirms the live scan matches the committed baseline.

## Tests
**Convention #6 conversions (every assertion preserved; only env-setup mechanism changes):**
- `src/lib/shared/__tests__/feedback-hmac.test.ts` — sets `CSRF_SECRET` in
  `beforeEach`; convert to set→`resetModules`→import.
- `src/lib/shared/__tests__/session-cookie-secret.test.ts` — sets/deletes
  `SESSION_COOKIE_SECRET` per-test; convert.
- `src/lib/shared/__tests__/worker-public-url.test.ts` — sets/deletes
  `WORKER_PUBLIC_URL` per-test; convert.
- `src/lib/admin/impersonation/__tests__/cookie.test.ts` — sets/deletes
  `IMPERSONATION_COOKIE_SECRET` per-test; convert.
- `src/lib/analytics/__tests__/posthog.test.ts` — `vi.stubEnv('POSTHOG_*')`
  per-test; convert to reset→import (the `posthog-node` hoisted mock re-applies).
- `src/app/api/lead-intake/__tests__/route.test.ts` — sets `OWNER_LEADS_*` /
  `GOOGLE_SHEETS_*` before a per-test `import('../route')`; add `vi.resetModules()`
  so the config memo re-parses the configured env on the Sheets-success path.
- `src/lib/costs/__tests__/onboarding-demo-cost-guard.test.ts` — does NOT mutate
  `ONBOARDING_DEMO_DAILY_CENTS` (tests the Redis-override / default path), so no
  conversion needed; kept green.

**Added (behavior-preservation):**
- `src/lib/config/__tests__/server.test.ts` — the 6 NEW optional vars
  present-when-set / `undefined`-when-unset; and a whitespace-`'   '` passthrough
  spot-check on `SESSION_COOKIE_SECRET` + `IMPERSONATION_COOKIE_SECRET` +
  `CSRF_SECRET` + `WORKER_PUBLIC_URL` (the four switched from `optionalVar` →
  `rawOptionalVar`; RED under the collapsing field, GREEN under `rawOptionalVar`).
- A focused behavior spot-check that `ONBOARDING_DEMO_DAILY_CENTS` still drives
  the demo ceiling default-on-unset + honors-valid via the migrated read.

## Deferred to a follow-up batch (explicit)
1. **CRITICAL cost guard** `costs/tracker.ts` — dynamic-key `*_CENTS` reads; LEAVE.
2. **SerpAPI + Redis-presence cluster** `reviews/serpapi-prefill.ts` (module-level
   `SERPAPI_TIMEOUT_MS`), `reviews/place-id-resolver.ts`, `shared/rate-limit.ts`
   (`REDIS_CACHE_URL`) — migrate together for one `REDIS_CACHE_URL` + SerpAPI decision.
3. **Zernio transport** `zernio/client/transport.ts` — migrate `ZERNIO_API_BASE`/
   `ZERNIO_API_KEY`; classify `MOCK_ZERNIO_LOCATION_COUNT` (mock knob) as
   indicator-exempt vs migrate (the file stays in baseline until that call).
4. **Notification channel cluster** `notifications/channels/{email,telegram-client,
   whatsapp-client,whatsapp-channel,whatsapp-body}.ts` — lane + co-resident flags.
5. **Payments** `payments/create-checkout-session.ts` `TRIAL_PERIOD_DAYS` (file
   stays in baseline anyway via NEXT_PUBLIC + flag).
6. Stage-4 flag homes (`auto-approval/flags.ts`, `*_ENABLED` readers) — Stage 4.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all must pass.

## Open risks
- The convention #6 conversion of `lead-intake/route.test.ts` is the only
  cross-cutting test change (the route exercises `owner-leads-sheet` transitively);
  it is mechanical (add `vi.resetModules()`), assertion-preserving.
- `shared/logger.ts` allowlisting (vs migration) is a deliberate foundational
  call — flagged for review; if a later batch wants it migrated, it must first
  prove no import cycle through `getServerConfig()` and accept a memoized parse on
  the lowest-level utility.
