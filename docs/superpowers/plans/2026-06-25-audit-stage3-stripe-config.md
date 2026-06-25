# Stage 3 BATCH — Stripe/payments config migration

_Branch `refactor/audit-stage3-stripe-config`. Migrates the Stripe/payments raw
`process.env.*` reads onto the Stage-2 typed config accessors
(`src/lib/config/{server,worker}.ts`), following the Stage-3 conventions
established by the email pilot
(`docs/superpowers/plans/2026-06-25-audit-stage3-pilot-email-config.md`)._

## Why this batch

Stripe/payments is the most behavior-sensitive subsystem in the campaign:
billing must not break. Every assert, tolerate-absent, fallback, parse, and
flag-deferral here is preserved EXACTLY. Where a migration would alter any
semantic, the read is left as-is and reported (never forced green).

**Hard rule (campaign-wide): ZERO PRODUCTION behavior change.** The extensive
billing/stripe/payments tests pass unchanged. A test's env-setup *mechanism* may
be refactored to set→reset→import so it works with the memoized accessor — that
is assertion-preserving (runtime env is immutable, so a memoized snapshot equals
a live read), not a behavior change.

The Stage-3 conventions that govern this batch (full text in the pilot plan):
#2 env-indicator exempt; #3 `*_ENABLED`/flag-like toggles → Stage 4; #4 shared
dual-runtime `src/lib` modules read via `getServerConfig()` (runtime-invoked);
#5 optional/fallback → optional schema field, NOT an asserting accessor; #7
migrated RAW reads use `rawOptionalVar` (faithful `''`/`'   '`/unset passthrough).

### Convention #4 refinement — `getServerConfig()` must be SHAPE-ONLY (campaign-wide)

A Codex correctness review caught a BLOCKER this batch surfaced (and that the
already-merged email pilot also latently carries): the server root `serverSchema`
had the three core-app vars (`NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_APP_URL`) as **required**
(`requiredVar`). But convention #4 routes shared `src/lib` modules' config reads
through `getServerConfig()`, and those modules run in the **Railway worker** —
whose env does NOT carry the Next public vars. So `getServerConfig()`'s
`serverSchema.parse(process.env)` threw a `ZodError` ("expected string, received
undefined" for `NEXT_PUBLIC_SUPABASE_URL`) **before** the subsystem's own check —
breaking the worker Stripe client (and, latently, the worker email path) even when
`STRIPE_SECRET_KEY`/`RESEND_API_KEY` were set. `rawOptionalVar` does NOT address
this — the failure is the required core vars, not whitespace.

**Refinement (now codified):** `getServerConfig()` is **SHAPE-ONLY** — *every*
field is optional in the root parse, including the three core-app vars (changed to
`rawOptionalVar`). **Required-ness lives ONLY in the boot asserts**
(`assertCoreAppConfig()` at Next `register()`, `getServerDbConfig()`, the
subsystem accessors), never the root parse. This matches the server.ts header's
own stated intent ("Root schema is SHAPE-ONLY … asserted ONLY by that subsystem's
accessor") — leaving the core vars `required` in the root was the deviation.
Net: `getServerConfig()` is now safe to call from any worker-run shared module
that lacks the Next public vars. `assertCoreAppConfig()` (STATIC `process.env.X`
refs) remains the SOLE enforcer of these at Next-server boot — unchanged; the Next
server still fails to boot without them. The separate `clientSchema` /
`assertClientConfig()` (prebuild) still requires them. `CORE_APP_REQUIRED_VARS` /
`CLIENT_REQUIRED_VARS` (the assert lists `ci:config-coverage` reads) are unchanged,
so coverage still passes. **Retroactively de-risks the email pilot** (its worker
email modules call `getServerConfig()` too).

Locked by a lane-safety regression test (`config/__tests__/server.test.ts`:
`getServerConfig()` does NOT throw when `NEXT_PUBLIC_*` absent + a subsystem
secret set; `payments/__tests__/stripe-config-migration.test.ts`: `getStripe()`
constructs in that worker-like env). Both are RED with the core vars required,
GREEN once they are shape-only.

---

## Per-file treatment (verified against the code)

| File:line | Var | Status | Before → After / why |
|---|---|---|---|
| `src/lib/payments/stripe-client.ts:26` | `STRIPE_SECRET_KEY` | ✅ migrated | `const key = process.env.STRIPE_SECRET_KEY; if (!key) throw 'STRIPE_SECRET_KEY is not set'` → `const key = getServerConfig().STRIPE_SECRET_KEY; if (!key) throw …`. The **narrow raw assert** (`if (!key)` on the RAW value) is preserved byte-for-byte. `STRIPE_SECRET_KEY` switched to `rawOptionalVar` in `serverSchema` (#7) so a whitespace-only `'   '` stays truthy and is passed to `new Stripe('   ')` exactly as the old raw read did (the collapsing `optionalVar` would map `'   '`→`undefined` → spurious throw). Shared dual-runtime module (server routes: `portal`, `tier-change`, `reactivate`, `create-checkout-session`; worker: 6 call sites) → `getServerConfig()` per #4; called at RUNTIME inside `getStripe()` (lazy singleton), never at import, so worker dotenv ordering is safe. **NOT** `getStripeConfig()`: that over-asserts key + webhook + 7 prices, which this site does NOT. |
| `src/lib/payments/price-tier-map.ts:35-49` | `STRIPE_PRICE_*` (7) | ⛔ NOT migrated — **allowlisted** | Tolerate-absent (`process.env.STRIPE_PRICE_X` → `string \| undefined`, `\|\| null` at call sites). This module is imported by `src/lib/config/{server,worker}.ts` AND `src/lib/config/stripe-shape.ts` (for `STRIPE_PRICE_ENV_VARS`), so reading `getServerConfig()` here would be a **circular import** (`config/server` → `price-tier-map` → `config/server`). It is the **single owner of the price-var list** the config schemas derive from — config-adjacent. Resolution: add `src/lib/payments/price-tier-map.ts` to `process-env-audit`'s `ALLOWLIST_FILES` with a comment, and remove it from the baseline. Its reads stay EXACTLY as-is. |
| `src/lib/payments/create-checkout-session.ts:124` | `STRIPE_TAX_ENABLED` | ⛔ flag → Stage 4 | `process.env.STRIPE_TAX_ENABLED === 'true'` is a feature flag (#3) — left untouched. (`:41 TRIAL_PERIOD_DAYS` and `:115 NEXT_PUBLIC_APP_URL` are out of this batch's scope; the file stays in the baseline on their account.) No Stripe-config (non-flag) read here. |
| `worker/ingress/stripe.ts:30` | `STRIPE_WEBHOOK_SECRET` | ✅ migrated | `const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET; if (!webhookSecret) { console.error(…); reply.status(401).send({ error: 'webhook_secret_not_configured' }); return; }` → `const webhookSecret = getWorkerConfig().STRIPE_WEBHOOK_SECRET; if (!webhookSecret) { … }`. Worker-only ingress file → **worker lane** (`getWorkerConfig()` self-loads dotenv, safe to call here). The exact `if (!webhookSecret)` 401 reject is preserved. `STRIPE_WEBHOOK_SECRET` switched to `rawOptionalVar` in `workerSchema` (#7) so the raw truthy check is byte-identical. (Not read raw via the server lane anywhere, so `serverSchema.STRIPE_WEBHOOK_SECRET` stays `opt` — only consumed by the asserting `getStripeConfig`/`narrowStripeConfig`, which test presence via `requirePresentIn` regardless of the field.) |
| `worker/background/pollers/StripeLocationsReconcilePoller.ts:209` | `STRIPE_LOCATIONS_RECONCILE_DISABLED` | ⛔ flag-like → Stage 4 | `=== 'true'` disable toggle — left untouched (#3). |
| `…StripeLocationsReconcilePoller.ts:213` | `MOCK_EXTERNAL_APIS` | ⛔ env indicator — exempt | direct read stays (#2). |
| `…StripeLocationsReconcilePoller.ts:224` | `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS` | ✅ migrated | `const envInterval = process.env.STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS; const parsed = envInterval ? parseInt(envInterval, 10) : NaN; const interval = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS` → reads `getWorkerConfig().STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS` for `envInterval`. The `envInterval ? parseInt : NaN` + `Number.isFinite && >0 ? : DEFAULT` parse/default is preserved byte-for-byte. Worker-only poller → worker lane. New `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS` added to `workerSchema` as `rawOptionalVar` (a migrated raw read; the call site owns its own `envInterval ?` truthy check). NOTE: the file **stays in the baseline** because `:209` still reads the `STRIPE_LOCATIONS_RECONCILE_DISABLED` flag (Stage 4). |

### Out-of-scope raw `STRIPE_SECRET_KEY` read (reported, untouched)
`src/instrumentation.ts:13` (`if (!process.env.STRIPE_SECRET_KEY) return;`) also
reads the secret raw. It lives at `src/instrumentation.ts`, OUTSIDE the audit
scan dirs (`src/lib`, `worker`), so it is not in scope for this batch and the
prompt does not list it. Left untouched; a later batch covering `src/` root /
instrumentation can migrate it.

---

## Schema changes (`src/lib/config/{server,worker}.ts`)

- `serverSchema.STRIPE_SECRET_KEY`: `optionalVar` → **`rawOptionalVar`** (#7). The
  migrated `if (!key)` raw site needs `'   '` to survive as truthy. `getStripeConfig`
  / `narrowStripeConfig` are UNAFFECTED — they assert via `requirePresentIn`
  (`value.trim().length === 0` ⇒ absent), so whitespace stays "absent" for the
  asserting accessor regardless of the schema field.
- `workerSchema.STRIPE_WEBHOOK_SECRET`: `optionalVar` → **`rawOptionalVar`** (#7),
  for the migrated raw truthy check in `worker/ingress/stripe.ts`.
- `workerSchema`: **NEW** `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS: rawOptionalVar`
  — migrated raw read (the call site owns `envInterval ? parseInt : NaN`).
- `workerSchema` gains the `rawOpt` import (server already imports it).
- `getWorkerStripeConfig` / `getStripeConfig` unaffected: `STRIPE_WEBHOOK_SECRET`
  is still required by `STRIPE_REQUIRED_VARS` → `narrowStripeConfig`, which tests
  presence via `requirePresentIn` (whitespace-as-absent) independent of the field.

## Allowlist + baseline (`scripts/ci/process-env-baseline.ts`)

- **Allowlist** `src/lib/payments/price-tier-map.ts` (add to `ALLOWLIST_FILES`
  with a comment): config-adjacent single owner of `STRIPE_PRICE_ENV_VARS`;
  migrating it to `getServerConfig()` would be a circular import. Its tolerate-
  absent reads stay as-is. (Allowlisting also removes it from the baseline scan.)
- **Remove from baseline** (now have no non-exempt/non-flag `process.env` read):
  - `src/lib/payments/stripe-client.ts` (only `STRIPE_SECRET_KEY`, migrated)
  - `worker/ingress/stripe.ts` (only `STRIPE_WEBHOOK_SECRET`, migrated)
  - `src/lib/payments/price-tier-map.ts` (now allowlisted)
- **Stay in baseline** (still read a flag / out-of-scope var):
  - `worker/background/pollers/StripeLocationsReconcilePoller.ts` —
    `STRIPE_LOCATIONS_RECONCILE_DISABLED` flag (Stage 4)
  - `src/lib/payments/create-checkout-session.ts` — `STRIPE_TAX_ENABLED` flag +
    `TRIAL_PERIOD_DAYS` + `NEXT_PUBLIC_APP_URL` (out of scope)
  - `worker/ingress/stripe/shared.ts` — `ZERNIO_PUBLISHING_ENABLED` flag

Baseline **88 → 85** (−3: stripe-client, worker/ingress/stripe, price-tier-map).

## Campaign finding — `getStripeConfig` / `getWorkerStripeConfig` are mis-shaped

The Stage-2 asserting Stripe accessors (`getStripeConfig`, `getWorkerStripeConfig`,
and their `assert*` siblings) do an **all-or-nothing** assert of
`STRIPE_REQUIRED_VARS` = `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + the 7
price IDs. But REAL Stripe usage in this codebase is **narrower and split**:

- `getStripe()` (the client constructor) needs ONLY `STRIPE_SECRET_KEY` and does a
  narrow `if (!key) throw` — NOT the webhook secret, NOT the 7 prices.
- The webhook ingress needs ONLY `STRIPE_WEBHOOK_SECRET` (a separate 401 path).
- The price IDs are **tolerate-absent** at every call site
  (`basePriceIdForTier` → `… || null`); an unset price is a normal state, not an
  error to assert at construction.

So no real call site wants the all-or-nothing assert. Using `getStripeConfig()`
for `getStripe()` would over-assert (throw when the webhook secret or any price is
absent, where today it does not). This batch therefore does NOT use the asserting
accessors; it routes each site through `getServerConfig()`/`getWorkerConfig()` and
keeps the site's own narrow assert/tolerate-absent.

**Recommendation (later cleanup, not this batch):** reshape or remove
`getStripeConfig`/`assertStripeConfig`/`getWorkerStripeConfig`/`assertWorkerStripeConfig`
— they assert a combination no consumer needs. This validates the Stage-2 thermo
"speculative accessor" concern (accessors built before a consumer existed got the
shape wrong). They remain unwired (`fallow-ignore unused-export`) and unused after
this batch.

## Test plan

Behavior preserved (existing tests — every assertion intact; env-setup mechanism
converted to set→reset→import only where the memoized accessor requires it, #6):

- `src/lib/payments/__tests__/stripe-client.test.ts` — converted to
  set→reset→import (it calls `getStripe()` which now reads the memoized
  `getServerConfig()`). Every assertion unchanged: pins apiVersion/timeout/retries;
  throws on empty `STRIPE_SECRET_KEY`; returns the pinned singleton.
- `worker/ingress/__tests__/stripe.test.ts`,
  `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`,
  `…/stripe-activation-enqueue.test.ts`, `…/webhook-dedup.test.ts` — set
  `STRIPE_WEBHOOK_SECRET`/`STRIPE_SECRET_KEY` BEFORE the static import and never
  mutate mid-file, so the first `getWorkerConfig()`/`getServerConfig()` parse
  snapshots the set value = live read. Untouched unless the run shows otherwise.
- `worker/background/pollers/__tests__/StripeLocationsReconcilePoller.test.ts` —
  sets `STRIPE_SECRET_KEY` + price + interval in `beforeEach`. Converted to
  set→reset→import only if the memoized accessor requires it (see #6); every
  assertion preserved.
- `src/lib/payments/__tests__/price-tier-map.test.ts`,
  `create-checkout-session.test.ts` — untouched (no migration there).

Added:
- `src/lib/payments/__tests__/stripe-config-migration.test.ts` — behavior-
  preservation for the raw-semantics-critical sites (set→reset→import, #6):
  whitespace-only `STRIPE_SECRET_KEY='   '` → `getStripe()` does NOT throw and
  passes the raw `'   '` to `new Stripe(...)` (matches the old raw read; RED under
  the collapsing `optionalVar`, GREEN under `rawOptionalVar`); `STRIPE_SECRET_KEY`
  present → constructs; unset/empty → throws the same message.
- `src/lib/config/__tests__/server.test.ts` — `STRIPE_SECRET_KEY` present-when-set
  and `undefined`-when-unset via `getServerConfig()` (tolerate-absent, no throw).
- `src/lib/config/__tests__/worker.test.ts` — `STRIPE_WEBHOOK_SECRET` +
  `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS` present-when-set / `undefined`-when-unset
  via `getWorkerConfig()`.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all must pass.

## Status / open risks
- Migrated: `STRIPE_SECRET_KEY` (stripe-client), `STRIPE_WEBHOOK_SECRET`
  (ingress), `STRIPE_LOCATIONS_RECONCILE_INTERVAL_MS` (reconcile poller).
- Left as-is (reported): `STRIPE_PRICE_*` (circular dep → allowlisted),
  `STRIPE_TAX_ENABLED` / `STRIPE_LOCATIONS_RECONCILE_DISABLED` (flags → Stage 4),
  `TRIAL_PERIOD_DAYS` + `NEXT_PUBLIC_APP_URL` (checkout, out of scope),
  `src/instrumentation.ts STRIPE_SECRET_KEY` (out of scan scope), `MOCK_EXTERNAL_APIS`
  (env indicator, exempt).
- Campaign finding: the asserting Stripe accessors are mis-shaped (all-or-nothing
  assert no consumer needs) — recommend reshape/removal in a later cleanup.
