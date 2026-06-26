# Stage 3 BATCH — out-of-guard `src/app/**` route config migration

_Branch `refactor/audit-stage3-out-of-guard`. Migrates scattered server-side raw
`process.env.*` reads in `src/app/**` (Next route handlers + one landing Server
Component) onto `getServerConfig()`. Behavior is byte-for-byte unchanged — only the
read SOURCE moves to config. Conventions referenced by number are defined in
`2026-06-25-audit-stage3-pilot-email-config.md`._

## Why this batch is distinct: OUT of the audit's guard

The `process-env` audit (`scripts/ci/process-env-audit.ts`) scans **only**
`src/lib/**` + `worker/**`. The reads migrated here live in `src/app/**`, which the
audit never scanned. Consequences:

- **The baseline does NOT change** — it stays **32** (`scripts/ci/process-env-baseline.ts`
  is untouched; `ci:process-env` reports `baseline 32` before and after). These files
  were never counted, so migrating them neither shrinks nor grows the baseline.
- **`ci:process-env` will NOT enforce these reads** going forward — a future
  `process.env.X` reintroduced in one of these `src/app` files would not be caught by
  the audit. The value of this batch is **Q4 config-ownership** (one typed home for the
  config surface), not audit enforcement.

So this is a *voluntary* extension of the Stage-3 migration past the audit boundary,
chosen because these reads are real subsystem config that belongs in the typed schema.

## Why server lane (`getServerConfig()`)

All six migrated reads run in the **Next server process** (route handlers + one Server
Component render). `getServerConfig()` is the SHAPE-ONLY server lane (every field
`.optional()`, never throws — convention #4/#5). None of the migrated vars is a
`NEXT_PUBLIC_*`, so there is **no build-inlining concern** (convention #1 does not
apply): a server-side read through `getServerConfig()[X]` reads raw runtime env, which
is exactly what a server route wants. Each read is invoked **inside a function / at
render time**, never at module import (convention #4 runtime-invocation constraint), so
the memo first populates at request time.

## The 5 new schema fields (`src/lib/config/server.ts`, all `rawOptionalVar`)

Each migrated call site owns its own normalization guard (`?? 'fallback'`, `!value`,
`?.trim() || …`), so the RAW value must survive verbatim (convention #7) — the
collapsing `optionalVar` would map `''`/`'   '` to `undefined` and flip whitespace edge
cases. All five are therefore `rawOpt = rawOptionalVar`:

| New field | Call site / guard |
|---|---|
| `ZERNIO_PROFILE_ID_PREFIX` | `zernio/connect/start` — `?? 'repworth-prod-'` |
| `TWILIO_WHATSAPP_NUMBER` | admin + dashboard `whatsapp/start` — `!`.replace(...) |
| `TELEGRAM_BOT_USERNAME` | admin `?? 'RepWorthBot'`, dashboard `?.trim() || 'RepWorthBot'` |
| `REDIS_QUEUE_URL` | `admin/jobs` queue-health probe — `if (!url)` gate |
| `REDIS_QUEUE_TOKEN` | `admin/jobs` queue-health probe — ioredis `password` |

`TWILIO_WHATSAPP_NUMBER` is also declared in `worker.ts` (the worker WhatsApp send
batch, as `rawOpt`). A var living in **both** schemas is fine and intentional — same as
`RESEND_FROM_EMAIL` (worker + server). Both lanes read the same `process.env`; the two
schema entries are independent shape declarations.

### Reused (NOT re-added) existing server.ts fields
- `TRIAL_PERIOD_DAYS` (rawOpt) — added by the trial-period-days batch; consumed by
  `(public)/page.tsx` here.
- `REDIS_CACHE_URL` (rawOpt) — added by the serpapi-redis batch; consumed by
  `admin/demos/generate` here.

## Per-file before → after (6 migrated files)

| File | Var | Before → After / why behavior-identical |
|---|---|---|
| `src/app/(public)/page.tsx` | `TRIAL_PERIOD_DAYS` | `Number.parseInt(process.env.TRIAL_PERIOD_DAYS ?? '', 10)` → `Number.parseInt(getServerConfig().TRIAL_PERIOD_DAYS ?? '', 10)`. Server Component (`force-dynamic`); `getServerConfig()` runs server-side at render. `?? ''` + parseInt + `>0 ? : 30` guard kept byte-for-byte. |
| `src/app/api/admin/demos/generate/route.ts` | `REDIS_CACHE_URL` | `if (!process.env.REDIS_CACHE_URL)` → `if (!getServerConfig().REDIS_CACHE_URL)`. The fail-CLOSED 503 gate (Redis-down → no uncapped demo spend) is unchanged; rawOpt keeps `'   '` truthy so the gate flips identically. |
| `src/app/api/zernio/connect/start/route.ts` | `ZERNIO_PROFILE_ID_PREFIX` | `process.env.ZERNIO_PROFILE_ID_PREFIX ?? 'repworth-prod-'` → `getServerConfig().…`. Read inside `POST` (after the flag/CSRF/auth/sub gates, Step D), never at import. Fallback preserved. |
| `src/app/api/admin/channels/whatsapp/start/route.ts` | `TWILIO_WHATSAPP_NUMBER` | `process.env.TWILIO_WHATSAPP_NUMBER!.replace(/^whatsapp:\+?/, '')` → `getServerConfig().TWILIO_WHATSAPP_NUMBER!.replace(/^whatsapp:\+?/, '')`. `!` non-null assertion AND the admin-specific `/^whatsapp:\+?/` regex preserved exactly. |
| `src/app/api/dashboard/channels/whatsapp/start/route.ts` | `TWILIO_WHATSAPP_NUMBER` | `process.env.TWILIO_WHATSAPP_NUMBER!.replace(/\D/g, '')` → `getServerConfig().TWILIO_WHATSAPP_NUMBER!.replace(/\D/g, '')`. The dashboard-specific `/\D/g` regex (differs from admin's) preserved exactly. |
| `src/app/api/admin/channels/telegram/start/route.ts` | `TELEGRAM_BOT_USERNAME` | `process.env.TELEGRAM_BOT_USERNAME ?? 'RepWorthBot'` → `getServerConfig().TELEGRAM_BOT_USERNAME ?? 'RepWorthBot'`. `??` normalization preserved. |
| `src/app/api/dashboard/channels/telegram/start/route.ts` | `TELEGRAM_BOT_USERNAME` | `process.env.TELEGRAM_BOT_USERNAME?.trim() || 'RepWorthBot'` → `getServerConfig().TELEGRAM_BOT_USERNAME?.trim() || 'RepWorthBot'`. The `?.trim() || …` form (collapses blank/whitespace to the default — distinct from admin's `??`) preserved exactly. |
| `src/app/api/admin/jobs/route.ts` | `REDIS_QUEUE_URL`, `REDIS_QUEUE_TOKEN` | `const redisUrl = process.env.REDIS_QUEUE_URL` → `getServerConfig().REDIS_QUEUE_URL`. In `parseRedisUrl()`: `const cfg = getServerConfig()` read once at the top, then `password: cfg.REDIS_QUEUE_TOKEN` (https branch) and `password: parsed.password || cfg.REDIS_QUEUE_TOKEN || undefined` (URL branch). The two-branch connection-building logic is byte-for-byte unchanged. |

## LEFT un-migrated (deliberate — documented)

- **`src/app/instrumentation.ts`** — the Next **boot/Sentry-init** file. Its `SENTRY_DSN`
  reads are the Sentry initialization (symmetric with the already-ALLOWLISTED
  `worker/sentry.ts`); `STRIPE_SECRET_KEY` is a boot presence-gate; `NEXT_RUNTIME` is a
  runtime indicator (convention #2 class). All stay direct `process.env` reads —
  boot-time/init reads analogous to the allowlisted worker Sentry init. Not subsystem
  config flowing through a request handler.
- **`scripts/**`** — dev/CI tooling that runs OUTSIDE the Next/worker runtime. Not app
  config; leave direct.
- **`whatsapp/_shared` + `telegram/_shared` env-readiness asserts** (`assertWhatsAppEnvReady`
  / `assertTelegramEnvReady`) — out of scope for this batch. They are presence-gate
  checks on the same vars but a separate concern; the spec scoped this batch to the six
  deep-link/gate reads above only. Left exactly as-is.

## Tests — memo-reset conversions (conventions #6/#7)

`getServerConfig()` memoizes the first `process.env` parse. These route tests
**statically import** the handler (the module-under-test is not re-imported per test),
so a test that mutates a migrated var mid-run must clear the memo or the migrated read
returns a stale snapshot. Fix: import `resetServerConfigForTests` from
`@/lib/config/server` and call it at the END of `beforeEach` (after that hook's env
setup). Each test sets/deletes its env BEFORE invoking the route, so a cleared memo lets
the first `getServerConfig()` inside the handler re-parse that test's env. **No `dotenv`
stub is needed (#9) — `getServerConfig()` does not self-load dotenv.** Every prior
assertion is preserved; only the env-setup *mechanism* changed (assertion-preserving —
runtime env is immutable, so a memoized snapshot equals a live read).

| Test file | Migrated var(s) it exercises | Conversion |
|---|---|---|
| `admin/channels/telegram/__tests__/start.test.ts` | `TELEGRAM_BOT_USERNAME` (set mid-body) | `resetServerConfigForTests()` at end of `beforeEach`. |
| `dashboard/channels/telegram/__tests__/start.test.ts` | `TELEGRAM_BOT_USERNAME` (MyCustomBot / `'   '` / unset, all mid-body) | same. |
| `admin/channels/whatsapp/__tests__/start.test.ts` | `TWILIO_WHATSAPP_NUMBER` (set mid-body) | same. |
| `dashboard/channels/whatsapp/__tests__/start.test.ts` | `TWILIO_WHATSAPP_NUMBER` (beforeEach default + mid-body override) | same. |
| `dashboard/channels/whatsapp/__tests__/enroll-e2e.integration.test.ts` | `TWILIO_WHATSAPP_NUMBER` (beforeEach; asserts `wa.me/15551230000`) | same (runs unconditionally — DB seam mocked). |
| `zernio/connect/start/__tests__/route.test.ts` | `ZERNIO_PROFILE_ID_PREFIX` (set once at module load) | same — belt-and-suspenders against import-time memo creep; asserts `createProfile({ name: 'test-profile-…' })`. |
| `admin/demos/generate/__tests__/route.test.ts` | `REDIS_CACHE_URL` (top-level default; 503 test deletes mid-body, restores) | same — the 503 test's delete lands before POST after the beforeEach reset; restore + next test's beforeEach reset keep subsequent tests on the present-REDIS path. |

### Schema-lock test (`src/lib/config/__tests__/server.test.ts`)
Added one block for the 5 new vars: present-when-set, undefined-when-unset, and
whitespace-`'   '`-passthrough. The whitespace case is **RED under the collapsing
`optionalVar`** (which maps `'   '` → `undefined`) and GREEN under `rawOptionalVar` —
matching every existing rawOpt lock in this file.

### Suite-wide grep (each migrated var in `*.test.ts`)
- `TELEGRAM_BOT_USERNAME` / `TWILIO_WHATSAPP_NUMBER` / `ZERNIO_PROFILE_ID_PREFIX`: the
  `src/app` start-route tests above — converted. Worker-lane references
  (`src/lib/notifications/channels/__tests__/whatsapp-{channel,client}.test.ts`,
  `src/lib/config/__tests__/worker.test.ts`, `worker/config/__tests__/startup-assertion.test.ts`)
  read the **worker** schema / env-readiness, not the migrated server-route reads —
  left untouched. The whatsapp/telegram `cancel`/`disable`/`_shared` tests exercise the
  unmigrated `_shared` env-readiness asserts, not the deep-link reads — left untouched.
- `REDIS_CACHE_URL`: `admin/demos/generate` test — converted. (`admin/businesses/prefill`
  test matched on a different, unmigrated read — left untouched.)
- `REDIS_QUEUE_URL` / `REDIS_QUEUE_TOKEN`: **no `admin/jobs` test exists** — nothing to
  convert. Worker startup-assertion references are worker-lane — left untouched.

## Baseline
`process-env` baseline **unchanged at 32** — `src/app/**` is out of the audit's scan
scope, so migrating these reads does not move the count. `config-coverage` unchanged at
**7 required vars** (the 5 new fields are optional `rawOpt`, not required).

## Verify gate (all green)
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — lint ✓, typecheck ✓, test ✓ (6912 passed),
build ✓, tenant-scope ✓ (377), rls-audit ✓, static-policy ✓, config-coverage ✓ (7),
process-env ✓ (**baseline 32**), fallow ✓ (no issues in changed files).
