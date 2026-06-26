# Stage 3 BATCH — `TRIAL_PERIOD_DAYS` (payments/create-checkout-session)

_Branch `refactor/audit-stage3-trial-period-days`. Migrates the single
`TRIAL_PERIOD_DAYS` raw read in `src/lib/payments/create-checkout-session.ts`
onto `getServerConfig()`. Conventions defined in
`2026-06-25-audit-stage3-pilot-email-config.md`._

## Scope (deliberately small)
`create-checkout-session.ts` has three `process.env` reads:
- `TRIAL_PERIOD_DAYS` (L41, in `resolveTrialPeriodDays()`) — **migrated** this batch.
- `NEXT_PUBLIC_APP_URL` (L115) — literal #1 (Next-bundled route; stays inlined).
- `STRIPE_TAX_ENABLED` (L124) — flag #3 (→ Stage 4).

Because the other two reads are counted by the process-env audit (NEXT_PUBLIC is
NOT exempt; the flag awaits Stage 4), **the file stays in the baseline** — net
baseline unchanged at **33**. The value here is owning one more var in config
(Q4), not a baseline drop.

## Lane: Next-only → `getServerConfig()`
`create-checkout-session.ts` is imported only by Next routes
(`api/billing/checkout`, `api/onboarding/select-plan`) — no worker importer. So
`getServerConfig()` (shape-only, never throws on missing vars), read in-fn inside
`resolveTrialPeriodDays()`. **Next-only ⇒ no staging ride.**

## Change
- `resolveTrialPeriodDays()`: `const raw = process.env.TRIAL_PERIOD_DAYS` →
  `const raw = getServerConfig().TRIAL_PERIOD_DAYS`. The `if (!raw) return 30;
  parseInt(raw, 10); Number.isFinite && > 0 ? : 30` guard is byte-for-byte intact.
- `config/server.ts`: add `TRIAL_PERIOD_DAYS: rawOpt` (#7 — `if (!raw)` on the raw
  value; an empty `''` must stay falsy → default 30, exactly like the old read).

## Tests (convention #6 — every prior assertion preserved)
- `create-checkout-session.test.ts`: the trial `describe` now resets the config
  memo in `beforeEach` (`resetServerConfigForTests()`) so each `vi.stubEnv(
  'TRIAL_PERIOD_DAYS', …)` value is re-parsed. The `price-tier-map` `vi.mock` is
  upgraded to a partial mock (`importOriginal`) so `STRIPE_PRICE_ENV_VARS` — now
  pulled in transitively via `config/server.ts` — survives. All 6 assertions
  (omit / =30 / default-30 / =14, + 2 tax) unchanged.
- `config/__tests__/server.test.ts`: added a present/undefined/whitespace-`'   '`
  passthrough lock for `TRIAL_PERIOD_DAYS` (RED under the collapsing `optionalVar`).

## Baseline
Unchanged at **33** — `create-checkout-session.ts` stays (NEXT_PUBLIC_APP_URL
literal + STRIPE_TAX_ENABLED flag remain counted).

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all green.
