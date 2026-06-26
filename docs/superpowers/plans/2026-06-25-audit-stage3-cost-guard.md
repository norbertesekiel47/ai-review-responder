# Stage 3 BATCH — `costs/tracker.ts` cost-guard config migration (CRITICAL)

_Branch `refactor/audit-stage3-cost-guard`. Migrates the spend-safety
cost-reservation guard's two env reads onto `getServerConfig()`. The
reservation/limit LOGIC is byte-for-byte unchanged — only the read SOURCE moves
to config. User-approved "migrate both reads (full batch)". Conventions in
`2026-06-25-audit-stage3-pilot-email-config.md`._

## Why this is the highest-care batch
`costs/tracker.ts` is the architecture-invariant spend guard (cost-guard skill).
Touching it risks the financial circuit breaker, so every change is
behavior-preserving and locked by functional tests, full Codex, and a staging
ride.

## The two reads (the only `process.env` in the file)
1. `getGlobalLimitCents()` — `process.env.GLOBAL_DAILY_COST_LIMIT_CENTS` (static key).
2. `getTierLimitCents(tier)` — `process.env[\`DAILY_COST_LIMIT_CENTS_${envSuffix}\`]`
   (DYNAMIC key). `envSuffix = TIER_ENV_SUFFIX[tier] ?? tier.toUpperCase()`, where
   **`TIER_ENV_SUFFIX` maps `founders`/`founding`→`FOUNDING`, `standard`→`STANDARD`,
   `premium`→`PREMIUM`**, and `basic` (not in the map) → `BASIC` via `toUpperCase()`.
   So the only env keys ever formed are **FOUNDING / STANDARD / PREMIUM / BASIC**
   (note FOUNDING, not FOUNDERS — the subtle trap a naive migration would miss).

Both reads flow through `safeParseLimitCents(envVal, fallback)` (its own
`trim` + `^\d+$` + safe-integer validation + numeric fallback). **That function is
UNTOUCHED.**

## Lane: `getServerConfig()` (dual-imported)
`tracker.ts` is imported by the worker (`response-generation/generate-draft`) AND
a Next-reachable module (`shared/dashboard-regen-rate-limit`, the shared
regenerate limiter both authed entrypoints call). `getServerConfig()` is
shape-only (all fields optional, never throws) so it is safe in BOTH runtimes —
critically, it can't `ZodError` on Vercel where `REDIS_QUEUE_URL` (a
`getWorkerConfig` requirement) is absent. The limit reads themselves run only in
the worker (`reserveCost`), but `getServerConfig()` is the robust, future-proof
choice for a dual-imported file (convention #4).

## Change
- `getGlobalLimitCents()`: `process.env.GLOBAL_DAILY_COST_LIMIT_CENTS` →
  `getServerConfig().GLOBAL_DAILY_COST_LIMIT_CENTS`.
- `getTierLimitCents()`: keeps `envSuffix`/`envKey`/`fallback` EXACTLY; replaces the
  dynamic `process.env[envKey]` with a static-typed lookup over the four named
  config fields keyed by the full env key. For a canonical tier the value is the
  config value (= the env value, rawOpt passthrough). For an out-of-set envKey (an
  impossible non-canonical tier) → `undefined` → fallback, exactly like an unset
  `process.env.X`.
- `config/server.ts`: add `GLOBAL_DAILY_COST_LIMIT_CENTS` +
  `DAILY_COST_LIMIT_CENTS_{FOUNDING,STANDARD,PREMIUM,BASIC}` as **`rawOpt`** (#7 —
  the raw value must reach `safeParseLimitCents` so `''`/`'   '` hit the same
  numeric fallback as before).

## Why byte-for-byte
- `safeParseLimitCents` and `DEFAULT_TIER_LIMITS_CENTS`/`TIER_ENV_SUFFIX` are
  unchanged → identical parse/validation/fallback.
- `rawOpt` is a faithful passthrough → identical input to `safeParseLimitCents`.
- The only theoretical divergence (a non-canonical tier WITH a stray env var set)
  is impossible: `tier` is enum-constrained to `basic|standard|premium|founders`.

## Tests
- **No existing test sets the limit env vars** (the reserveCost tests mock
  `redis.eval`), so the default-limit path is unchanged — all 21 tracker + 21
  cost-guard cases pass untouched.
- **Added functional locks** (`tracker.test.ts`): set
  `DAILY_COST_LIMIT_CENTS_STANDARD`/`GLOBAL_DAILY_COST_LIMIT_CENTS`, reset the
  config memo, call `reserveCost`, and assert the bizLimit/globalLimit ARGV passed
  to the Lua script reflect the config — proving the config DRIVES the limits. A
  second lock proves the founders tier reads `DAILY_COST_LIMIT_CENTS_FOUNDING`
  (and ignores a stray `_FOUNDERS`).
- **Added schema locks** (`server.test.ts`): present/undefined/whitespace
  passthrough for the 5 new vars (RED under the collapsing `optionalVar`).

## Baseline
`process-env` baseline **33 → 32** — `costs/tracker.ts` removed (fully migrated).
`admin/cost-report-service.ts` reads the same `*_CENTS` vars at module-load and
stays **allowlisted** (independent import-time read; both see the same env).

## Verify gate (+ full Codex + staging ride — worker-touching)
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow`.
