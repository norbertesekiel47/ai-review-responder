# Stage 2 — Config Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the typed config FOUNDATION (split `src/lib/config/` modules + lane-scoped boot asserts + two CI guards) so Stage 3 can migrate the ~990 existing `process.env` reads onto a single typed layer — without changing the runtime behavior of anything that boots today.

**Architecture:** Three lane modules (`client.ts` / `server.ts` / `worker.ts`) each expose a **lazy, memoized** accessor that parses a Zod schema on first call (never at import). Root schemas are **shape-only**: core-app vars required, every subsystem secret `.optional()`. Required-ness for a subsystem lives at its per-subsystem accessor (`getStripeConfig()` asserts + narrows). Validation fires at BOOT via lane-scoped asserts: `assertCoreAppConfig()` (Next `instrumentation.ts`), `assertWorkerConfig()` (worker boot, after dotenv), `assertClientConfig()` (`prebuild`). A CI **coverage audit** proves every required var is asserted by exactly one lane; a CI **process-env baseline audit** prevents new raw `process.env` reads outside the sanctioned config home; a **no-secret build canary** proves no import-time secret dependency.

**Tech Stack:** TypeScript (strict, no `any`), Zod v4 (`zod@^4.4.3`, already a dep), Vitest, `tsx` AST-free file-scan audits (mirroring `scripts/ci/static-policy-audit.ts`), dotenv (worker lane self-loads `worker/env.ts`).

---

## Background facts the implementer MUST know (verified against the codebase)

These were established by reading the authoritative sources. Do not re-derive; trust them.

1. **The worker and Next server read DIFFERENT names for the same infra.** `src/lib/db/server.ts` (imported by BOTH lanes) reads `process.env.DATABASE_POOL_URL!`, `process.env.SUPABASE_URL!`, `process.env.SUPABASE_SERVICE_KEY!`. The *public/browser* Supabase URL is `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (different vars, `src/lib/db/browser.ts`). `DATABASE_URL` (non-pooled, migrations) is distinct from `DATABASE_POOL_URL`.

2. **Authoritative required-ness for the worker is `worker/config/startup-assert.ts`** (already read):
   - `CORE_INFRA_REQUIRED_ENV` = `DATABASE_POOL_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `REDIS_QUEUE_URL` — required unless (non-prod AND `MOCK_EXTERNAL_APIS=true`).
   - `assertStripeWorkerEnv()` requires `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the 7 `STRIPE_PRICE_ENV_VARS` (`src/lib/payments/price-tier-map.ts`) — same MOCK carve-out.
   - `assertAdminNotificationEmail()` requires `ADMIN_NOTIFICATION_EMAIL` — **production-only** (non-mock).
   - `assertAlertSinkEnv()` requires `SENTRY_DSN` — **production-only** (non-mock).
   - `assertServerOnlyFeatureOptionalBooleansEnv()` only validates that 4 boolean flags, *if set*, are exactly `'true'`/`'false'` (not presence).
   - Flag-conditional asserts (`assertSelfServeSignupEnv`, `assertChannelsTelegramEnv`, `assertChannelsWhatsAppEnv`, `assertZernioPublishingEnv`, `assertAccountOffboardingEnv`) require their secrets **only when the owning flag is `'true'`**.

3. **Worker boot order:** `worker/index.ts` line 1 `import './env'` (dotenv `.env.local`), line 2 `import './config/startup-side-effect-guard'` (calls `assertWorkerStartupEnv()`), then flag asserts run inside `start()` (lines ~301-306). Our `assertWorkerConfig()` must run AFTER dotenv, and must **not** require anything beyond what's required today.

4. **Next instrumentation:** `src/instrumentation.ts` `register()` already guards `process.env.NEXT_RUNTIME === 'nodejs'`. The new `assertCoreAppConfig()` call goes inside that nodejs guard.

5. **`zod@^4.4.3` is installed.** In Zod v4, `z.object({...}).parse()` is the API; `.optional()` makes a field `T | undefined`. No new deps.

6. **The CI `lint` job env block** (`.github/workflows/ci.yml`) sets non-prod dummy values for `NEXT_PUBLIC_*`, `SUPABASE_*`, `DATABASE_POOL_URL`, `REDIS_*`, etc., and `MOCK_EXTERNAL_APIS='false'`. `NODE_ENV` is unset there (so the production-only asserts no-op). The audits run in `lint`; they read FILES, not env, so they're env-independent.

7. **Audit conventions** (from `static-policy-audit.ts` / `tenant-scope-audit.ts`):
   - Pure exported `scanFile(file, text)` / `scanX(...)` functions, unit-tested.
   - `main()` walks `SCAN_DIRS`, prints `<name>: passed (N files)` / `<name>: failed` + per-finding lines, `process.exit(1)` on findings.
   - Self-execution guard: `if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()...`.
   - **Baseline pattern** (from `tenant-scope-allowlist.ts`): an exported `BASELINE` integer + a committed data module; the audit fails if the live count ≠ BASELINE in EITHER direction, forcing an explicit reviewed bump.
   - `SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/`, `SKIP_DIRS` includes `__tests__`, `node_modules`, `dist`, `.next`, `coverage`.

8. **There are 101 files** under `src/lib/**` + `worker/**` (excluding tests) that read `process.env` today. The process-env audit's committed baseline is the exact set its own scan produces — generate it from the audit, do not hand-curate.

---

## The var → lane → required mapping (source of truth for the schemas)

**Lane = which config module owns the var. Required = asserted at that lane's boot assert.** Derived from `startup-assert.ts` (worker) + env-vars.md (meaning/lane) + `db/server.ts`/`db/browser.ts` (actual reads). "Required" below = *unconditionally* boot-required outside the MOCK/prod carve-outs; everything else is `.optional()` in the root schema and (where applicable) asserted by a subsystem accessor.

### CLIENT lane (`config/client.ts`) — `NEXT_PUBLIC_*`, build-inlined

| Var | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **required** | browser Supabase URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **required** | browser anon key |
| `NEXT_PUBLIC_APP_URL` | **required** | full origin |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | optional | PlaceAutocomplete (onboarding only) |
| `NEXT_PUBLIC_SENTRY_DSN` | optional | browser Sentry |
| `NEXT_PUBLIC_DOCS_BASE_URL` | optional | admin runbook links |

`assertClientConfig()` asserts the three required public vars (it parses the client schema's required fields).

### SERVER lane (`config/server.ts`) — Next.js server process

**Core-app required** (asserted by `assertCoreAppConfig()` — the minimum every Next server process truly needs to serve a page + read its own DB):

| Var | Required | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **required** | also needed server-side for SSR auth |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **required** | SSR auth |
| `NEXT_PUBLIC_APP_URL` | **required** | absolute links / redirects |
| `SUPABASE_URL` | **required** | server reads (`db/server.ts`) |
| `SUPABASE_SERVICE_KEY` | **required** | server reads (`db/server.ts`) |
| `DATABASE_POOL_URL` | **required** | server reads (`db/server.ts`) |

> Rationale for treating these six as core-app-required: every authenticated Next route already dereferences them via `db/server.ts` / SSR auth with non-null assertions, so a missing value already fails the first request today. Asserting them at `register()` only moves an already-certain failure earlier — no env that boots today newly fails. (`DATABASE_URL`, the non-pooled migrations URL, is NOT read by the serving path → optional.)

**Subsystem secrets — all `.optional()` in the root schema, asserted+narrowed only by their accessor:**

| Subsystem accessor | Vars asserted | Notes |
|---|---|---|
| `getStripeConfig()` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, + 7 `STRIPE_PRICE_*` | mirrors `assertStripeWorkerEnv` set; Next uses Stripe in checkout/tier routes |
| `getResendConfig()` | `RESEND_API_KEY` | transactional email |
| `getSerpapiConfig()` | `SERPAPI_API_KEY` | prefill / place-id resolution |
| `getOpenAiConfig()` | `OPENAI_API_KEY` | (server rarely; included for completeness) |
| `getGoogleMapsConfig()` | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | server-readable public var |

Other server-only optionals carried in the root schema shape (NOT asserted by any subsystem accessor here — they belong to Stage 3/4 or are degrade-on-absence): `DATABASE_URL`, `REDIS_CACHE_URL`, `SENTRY_DSN`, `SESSION_COOKIE_SECRET`, `CSRF_SECRET`, `IMPERSONATION_COOKIE_SECRET`, `CONTACT_NOTIFY_TO`, `NEXT_PUBLIC_DOCS_BASE_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `DB_POOL_MAX`, `WORKER_PUBLIC_URL`. These are shape-only entries so `getServerConfig()` returns a typed object; their presence is enforced (where it matters) by existing runtime guards, not by this Stage.

### WORKER lane (`config/worker.ts`) — Railway worker process

**Core-infra required** (asserted by `assertWorkerConfig()` core block — exactly mirrors `CORE_INFRA_REQUIRED_ENV`, with the same `(non-prod && MOCK_EXTERNAL_APIS) → skip` carve-out):

| Var | Required | Notes |
|---|---|---|
| `DATABASE_POOL_URL` | **required** | `db/server.ts` |
| `SUPABASE_URL` | **required** | `db/server.ts` |
| `SUPABASE_SERVICE_KEY` | **required** | `db/server.ts` |
| `REDIS_QUEUE_URL` | **required** | BullMQ queue |

**Worker subsystem accessors** — `.optional()` in root, asserted by accessor:

| Subsystem accessor | Vars asserted | Notes |
|---|---|---|
| `getWorkerStripeConfig()` | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, + 7 `STRIPE_PRICE_*` | mirrors `assertStripeWorkerEnv` |
| `getWorkerResendConfig()` | `RESEND_API_KEY` | worker email |
| `getWorkerSerpapiConfig()` | `SERPAPI_API_KEY` | ranking worker |
| `getWorkerOpenAiConfig()` | `OPENAI_API_KEY` | LLM primary |
| `getWorkerAnthropicConfig()` | `ANTHROPIC_API_KEY` | LLM fallback |

Worker root-schema optionals carried for shape (NOT asserted this Stage; presence still owned by the existing flag asserts in `startup-assert.ts` which we do NOT touch): `ADMIN_NOTIFICATION_EMAIL`, `SENTRY_DSN`, `REDIS_CACHE_URL`, `WORKER_PUBLIC_URL`, `PORT`, `DATABASE_URL`, plus all Telegram/WhatsApp/Zernio/offboarding secrets and the poller-tuning numerics. We do not duplicate the production-only `ADMIN_NOTIFICATION_EMAIL`/`SENTRY_DSN` asserts into `assertWorkerConfig()` — `startup-assert.ts` still owns them and runs alongside us. (Coverage audit, below, treats them as asserted by the existing worker startup path; see the audit's "asserted-var registry" note.)

### Why this preserves "validate-all" without one global parse

Every var that is **unconditionally boot-required today** appears in exactly one lane's assert:
- Client-required trio → `assertClientConfig()`.
- Server core-app six → `assertCoreAppConfig()`.
- Worker core-infra four → `assertWorkerConfig()`.

The **coverage audit** enumerates the union of these three asserts' required-var lists and checks: (a) no required var is absent from all three, (b) no required var appears in two of them in a *conflicting* lane (the shared infra vars `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`DATABASE_POOL_URL` legitimately appear in BOTH server and worker because both processes read them — this is allowed and declared, not a violation). Conditionally-required subsystem secrets are validated by their accessor + the untouched `startup-assert.ts` flag asserts, so nothing regresses.

---

## File Structure

**Create:**
- `src/lib/config/client.ts` — client schema, `getClientConfig()`, `assertClientConfig()`, `CLIENT_REQUIRED_VARS`.
- `src/lib/config/server.ts` — server schema, `getServerConfig()` (lazy+memoized), `assertCoreAppConfig()`, `CORE_APP_REQUIRED_VARS`, subsystem accessors+asserts (`getStripeConfig`/`assertStripeConfig`, `getResendConfig`/`assertResendConfig`, `getSerpapiConfig`/`assertSerpapiConfig`, `getOpenAiConfig`/`assertOpenAiConfig`, `getGoogleMapsConfig`/`assertGoogleMapsConfig`).
- `src/lib/config/worker.ts` — worker schema, `getWorkerConfig()` (lazy+memoized, self-loads dotenv), `assertWorkerConfig()`, `WORKER_REQUIRED_VARS`, subsystem accessors+asserts (`getWorkerStripeConfig`/`assertWorkerStripeConfig`, …).
- `src/lib/config/dotenv-load.ts` — tiny idempotent dotenv loader shared by `worker.ts` (so importing a worker module outside `worker/index.ts` still loads `.env.local`).
- `src/lib/config/__tests__/client.test.ts`
- `src/lib/config/__tests__/server.test.ts`
- `src/lib/config/__tests__/worker.test.ts`
- `src/lib/config/__tests__/import-safety.test.ts`
- `scripts/ci/config-coverage-audit.ts`
- `scripts/ci/config-coverage-baseline.ts` — the declared required-var registry + `CONFIG_COVERAGE_BASELINE`.
- `scripts/ci/__tests__/config-coverage-audit.test.ts`
- `scripts/ci/process-env-audit.ts`
- `scripts/ci/process-env-baseline.ts` — committed baseline file-set + allowlist + `PROCESS_ENV_BASELINE` count.
- `scripts/ci/__tests__/process-env-audit.test.ts`
- `scripts/prebuild-assert-client-config.ts` — runs `assertClientConfig()` before `next build`.

**Modify:**
- `src/instrumentation.ts` — call `assertCoreAppConfig()` inside the `NEXT_RUNTIME === 'nodejs'` guard.
- `worker/index.ts` — call `assertWorkerConfig()` after `import './env'` (in `start()`, alongside existing asserts).
- `vitest.setup.ts` — add the remaining dummy env vars accessor-exercising tests may need (belt-and-suspenders).
- `package.json` — add `ci:config-coverage`, `ci:process-env`, `prebuild` scripts; make `build` depend on `prebuild` indirectly via the canary, see Task 7.
- `.github/workflows/ci.yml` — wire the two audits into `lint`; add a no-secret build canary step/job.

**Do NOT touch:** any existing `process.env` read; `worker/config/startup-assert.ts` (it keeps owning what it owns); any subsystem entry point (no subsystem-assert call-site wiring this Stage).

---

## Task 1: `dotenv-load.ts` — shared idempotent loader

**Files:**
- Create: `src/lib/config/dotenv-load.ts`
- Test: covered indirectly by worker.test.ts import-safety; no standalone test (trivial wrapper).

- [ ] **Step 1: Implement the loader**

```typescript
// src/lib/config/dotenv-load.ts
//
// Idempotent .env.local loader for the worker config lane. worker/env.ts already
// loads dotenv at worker boot, but a worker config module imported OUTSIDE
// worker/index.ts (a unit test, a one-off script) would otherwise parse an empty
// env. Calling this from config/worker.ts before the first parse closes that
// ordering hole (the "F3" gap). dotenv.config is itself idempotent and a no-op
// when the file is missing (production), so repeated calls are safe.
import dotenv from 'dotenv';

let loaded = false;

export function ensureWorkerDotenvLoaded(): void {
  if (loaded) return;
  loaded = true;
  dotenv.config({ path: '.env.local' });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-audit-stage2-config-foundation && pnpm typecheck`
Expected: PASS (no errors introduced).

- [ ] **Step 3: Commit**

```bash
git add src/lib/config/dotenv-load.ts
git commit -m "feat(config): idempotent worker dotenv loader"
```

---

## Task 2: `client.ts` — client lane (TDD)

**Files:**
- Create: `src/lib/config/client.ts`
- Test: `src/lib/config/__tests__/client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/config/__tests__/client.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
};

describe('config/client', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original }; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('assertClientConfig passes when required public vars are present', async () => {
    Object.assign(process.env, REQUIRED);
    const { assertClientConfig } = await import('../client');
    expect(() => assertClientConfig()).not.toThrow();
  });

  it('assertClientConfig throws naming the missing var', async () => {
    Object.assign(process.env, REQUIRED);
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { assertClientConfig } = await import('../client');
    expect(() => assertClientConfig()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('getClientConfig returns required + optional fields', async () => {
    Object.assign(process.env, REQUIRED, { NEXT_PUBLIC_SENTRY_DSN: 'https://x@y/1' });
    const { getClientConfig } = await import('../client');
    const cfg = getClientConfig();
    expect(cfg.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000');
    expect(cfg.NEXT_PUBLIC_SENTRY_DSN).toBe('https://x@y/1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/config/__tests__/client.test.ts`
Expected: FAIL ("Cannot find module '../client'").

- [ ] **Step 3: Implement `client.ts`**

```typescript
// src/lib/config/client.ts
//
// CLIENT lane — NEXT_PUBLIC_* only (build-inlined). The browser learns these at
// build time; a missing required one would otherwise inline as `undefined` and
// fail silently in the browser, so assertClientConfig() runs in the prebuild step.
import { z } from 'zod';

const nonEmpty = z.string().min(1);

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: nonEmpty,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_APP_URL: nonEmpty,
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().min(1).optional(),
  NEXT_PUBLIC_DOCS_BASE_URL: z.string().min(1).optional(),
});

export type ClientConfig = z.infer<typeof clientSchema>;

export const CLIENT_REQUIRED_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_APP_URL',
] as const;

let memo: ClientConfig | undefined;

/** Lazy, memoized parse. NEVER call z.parse at import time. */
export function getClientConfig(): ClientConfig {
  if (!memo) memo = clientSchema.parse(process.env);
  return memo;
}

/** Build/boot guard: validates the required public vars are present. */
export function assertClientConfig(): void {
  const result = clientSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`[config] client config invalid/missing: ${missing}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/config/__tests__/client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/config/client.ts src/lib/config/__tests__/client.test.ts
git commit -m "feat(config): client lane (lazy accessor + assertClientConfig)"
```

---

## Task 3: `server.ts` — server lane + core-app assert + subsystem accessors (TDD)

**Files:**
- Create: `src/lib/config/server.ts`
- Test: `src/lib/config/__tests__/server.test.ts`

The full required-var list and subsystem secret sets are in the mapping section above. The Stripe price var list is imported from `STRIPE_PRICE_ENV_VARS` (`src/lib/payments/price-tier-map.ts`) — a value import (allowed; it is not a `process.env` read).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/config/__tests__/server.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';

const CORE = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_KEY: 'svc',
  DATABASE_POOL_URL: 'postgres://t:t@localhost:5432/t',
};

describe('config/server', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original }; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('assertCoreAppConfig passes with the six core-app vars', async () => {
    Object.assign(process.env, CORE);
    const { assertCoreAppConfig } = await import('../server');
    expect(() => assertCoreAppConfig()).not.toThrow();
  });

  it('assertCoreAppConfig throws naming a missing core var', async () => {
    Object.assign(process.env, CORE);
    delete process.env.SUPABASE_SERVICE_KEY;
    const { assertCoreAppConfig } = await import('../server');
    expect(() => assertCoreAppConfig()).toThrow(/SUPABASE_SERVICE_KEY/);
  });

  it('getStripeConfig asserts presence and returns non-null secrets', async () => {
    Object.assign(process.env, CORE, {
      STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec',
    });
    for (const v of STRIPE_PRICE_ENV_VARS) process.env[v] = `price_${v}`;
    const { getStripeConfig } = await import('../server');
    const cfg = getStripeConfig();
    expect(cfg.STRIPE_SECRET_KEY).toBe('sk_test');
    expect(cfg.STRIPE_PRICE_BASIC).toBe('price_STRIPE_PRICE_BASIC');
  });

  it('getStripeConfig throws when a Stripe secret is missing', async () => {
    Object.assign(process.env, CORE, { STRIPE_WEBHOOK_SECRET: 'whsec' });
    const { getStripeConfig } = await import('../server');
    expect(() => getStripeConfig()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('getResendConfig throws when RESEND_API_KEY is missing', async () => {
    Object.assign(process.env, CORE);
    const { getResendConfig } = await import('../server');
    expect(() => getResendConfig()).toThrow(/RESEND_API_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/config/__tests__/server.test.ts`
Expected: FAIL ("Cannot find module '../server'").

- [ ] **Step 3: Implement `server.ts`**

```typescript
// src/lib/config/server.ts
//
// SERVER lane — Next.js server-process env. Root schema is SHAPE-ONLY: the six
// core-app vars (asserted at instrumentation register()) are required; every
// subsystem secret is .optional() so an innocent getServerConfig() in a UI-only
// preview never throws. A subsystem's secrets are asserted + narrowed to non-null
// ONLY by that subsystem's accessor. No top-level z.parse — getServerConfig is
// lazy + memoized.
import { z } from 'zod';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';

const nonEmpty = z.string().min(1);
const opt = z.string().min(1).optional();

// Build the Stripe price fields (optional in the root) from the single owner list.
const stripePriceShape = Object.fromEntries(
  STRIPE_PRICE_ENV_VARS.map((name) => [name, opt]),
) as Record<(typeof STRIPE_PRICE_ENV_VARS)[number], typeof opt>;

const serverSchema = z.object({
  // ── core-app required ──
  NEXT_PUBLIC_SUPABASE_URL: nonEmpty,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_APP_URL: nonEmpty,
  SUPABASE_URL: nonEmpty,
  SUPABASE_SERVICE_KEY: nonEmpty,
  DATABASE_POOL_URL: nonEmpty,
  // ── subsystem secrets (optional) ──
  STRIPE_SECRET_KEY: opt,
  STRIPE_WEBHOOK_SECRET: opt,
  ...stripePriceShape,
  RESEND_API_KEY: opt,
  SERPAPI_API_KEY: opt,
  OPENAI_API_KEY: opt,
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: opt,
  // ── shape-only optionals (not asserted this Stage) ──
  DATABASE_URL: opt,
  REDIS_CACHE_URL: opt,
  SENTRY_DSN: opt,
  NEXT_PUBLIC_SENTRY_DSN: opt,
  NEXT_PUBLIC_DOCS_BASE_URL: opt,
  SESSION_COOKIE_SECRET: opt,
  CSRF_SECRET: opt,
  IMPERSONATION_COOKIE_SECRET: opt,
  CONTACT_NOTIFY_TO: opt,
  WORKER_PUBLIC_URL: opt,
  DB_POOL_MAX: opt,
});

export type ServerConfig = z.infer<typeof serverSchema>;

export const CORE_APP_REQUIRED_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_APP_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'DATABASE_POOL_URL',
] as const;

let memo: ServerConfig | undefined;

/** Lazy, memoized parse. NEVER at import time. */
export function getServerConfig(): ServerConfig {
  if (!memo) memo = serverSchema.parse(process.env);
  return memo;
}

function requirePresent(vars: readonly string[], subsystem: string): void {
  const missing = vars.filter((v) => {
    const value = process.env[v];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`[config] ${subsystem} requires: ${missing.join(', ')}`);
  }
}

/** Core-app boot assert — the minimum every Next server process needs. */
export function assertCoreAppConfig(): void {
  requirePresent(CORE_APP_REQUIRED_VARS, 'core-app');
}

// ── Subsystem accessors: assert presence, return non-null-narrowed view ──

const STRIPE_SERVER_VARS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', ...STRIPE_PRICE_ENV_VARS] as const;

export interface StripeServerConfig {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_BASIC: string;
  STRIPE_PRICE_FOUNDING: string;
  STRIPE_PRICE_STANDARD: string;
  STRIPE_PRICE_PREMIUM: string;
  STRIPE_PRICE_STANDARD_OVERAGE: string;
  STRIPE_PRICE_PREMIUM_OVERAGE: string;
  STRIPE_PRICE_FOUNDERS_OVERAGE: string;
}

export function assertStripeConfig(): void {
  requirePresent(STRIPE_SERVER_VARS, 'stripe (server)');
}

export function getStripeConfig(): StripeServerConfig {
  assertStripeConfig();
  const cfg = getServerConfig();
  return {
    STRIPE_SECRET_KEY: cfg.STRIPE_SECRET_KEY!,
    STRIPE_WEBHOOK_SECRET: cfg.STRIPE_WEBHOOK_SECRET!,
    STRIPE_PRICE_BASIC: cfg.STRIPE_PRICE_BASIC!,
    STRIPE_PRICE_FOUNDING: cfg.STRIPE_PRICE_FOUNDING!,
    STRIPE_PRICE_STANDARD: cfg.STRIPE_PRICE_STANDARD!,
    STRIPE_PRICE_PREMIUM: cfg.STRIPE_PRICE_PREMIUM!,
    STRIPE_PRICE_STANDARD_OVERAGE: cfg.STRIPE_PRICE_STANDARD_OVERAGE!,
    STRIPE_PRICE_PREMIUM_OVERAGE: cfg.STRIPE_PRICE_PREMIUM_OVERAGE!,
    STRIPE_PRICE_FOUNDERS_OVERAGE: cfg.STRIPE_PRICE_FOUNDERS_OVERAGE!,
  };
}

export function assertResendConfig(): void {
  requirePresent(['RESEND_API_KEY'], 'resend (server)');
}
export function getResendConfig(): { RESEND_API_KEY: string } {
  assertResendConfig();
  return { RESEND_API_KEY: getServerConfig().RESEND_API_KEY! };
}

export function assertSerpapiConfig(): void {
  requirePresent(['SERPAPI_API_KEY'], 'serpapi (server)');
}
export function getSerpapiConfig(): { SERPAPI_API_KEY: string } {
  assertSerpapiConfig();
  return { SERPAPI_API_KEY: getServerConfig().SERPAPI_API_KEY! };
}

export function assertOpenAiConfig(): void {
  requirePresent(['OPENAI_API_KEY'], 'openai (server)');
}
export function getOpenAiConfig(): { OPENAI_API_KEY: string } {
  assertOpenAiConfig();
  return { OPENAI_API_KEY: getServerConfig().OPENAI_API_KEY! };
}

export function assertGoogleMapsConfig(): void {
  requirePresent(['NEXT_PUBLIC_GOOGLE_MAPS_API_KEY'], 'google-maps (server)');
}
export function getGoogleMapsConfig(): { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: string } {
  assertGoogleMapsConfig();
  return { NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: getServerConfig().NEXT_PUBLIC_GOOGLE_MAPS_API_KEY! };
}
```

> **Note on the `!` non-null assertions:** these are the only sanctioned use here — each is immediately preceded by `assertX()` / `requirePresent()` which throws if absent, so the value is provably non-null at the `!`. This is the documented "required-ness at the accessor" pattern, not papering over `any`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/config/__tests__/server.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/config/server.ts src/lib/config/__tests__/server.test.ts
git commit -m "feat(config): server lane (lazy accessor, core-app assert, subsystem accessors)"
```

---

## Task 4: `worker.ts` — worker lane + assertWorkerConfig + subsystem accessors (TDD)

**Files:**
- Create: `src/lib/config/worker.ts`
- Test: `src/lib/config/__tests__/worker.test.ts`

`assertWorkerConfig()` mirrors `CORE_INFRA_REQUIRED_ENV` exactly, with the same `(NODE_ENV !== 'production' && MOCK_EXTERNAL_APIS === 'true') → return` carve-out as `assertCoreInfraEnv()`. It does NOT add `ADMIN_NOTIFICATION_EMAIL`/`SENTRY_DSN` (those stay owned by `startup-assert.ts`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/config/__tests__/worker.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CORE = {
  DATABASE_POOL_URL: 'postgres://t:t@localhost:5432/t',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_KEY: 'svc',
  REDIS_QUEUE_URL: 'redis://localhost:6379/1',
};

describe('config/worker', () => {
  const original = process.env;
  beforeEach(() => { process.env = { ...original }; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('assertWorkerConfig passes with the four core-infra vars', async () => {
    process.env = { ...CORE, NODE_ENV: 'test' };
    const { assertWorkerConfig } = await import('../worker');
    expect(() => assertWorkerConfig()).not.toThrow();
  });

  it('assertWorkerConfig throws naming a missing core-infra var (non-mock)', async () => {
    process.env = { ...CORE, NODE_ENV: 'test', MOCK_EXTERNAL_APIS: 'false' };
    delete process.env.REDIS_QUEUE_URL;
    const { assertWorkerConfig } = await import('../worker');
    expect(() => assertWorkerConfig()).toThrow(/REDIS_QUEUE_URL/);
  });

  it('assertWorkerConfig is a no-op in non-prod MOCK mode even when vars are absent', async () => {
    process.env = { NODE_ENV: 'test', MOCK_EXTERNAL_APIS: 'true' } as NodeJS.ProcessEnv;
    const { assertWorkerConfig } = await import('../worker');
    expect(() => assertWorkerConfig()).not.toThrow();
  });

  it('getWorkerStripeConfig throws when a Stripe price var is missing', async () => {
    process.env = { ...CORE, NODE_ENV: 'test', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh' };
    const { getWorkerStripeConfig } = await import('../worker');
    expect(() => getWorkerStripeConfig()).toThrow(/STRIPE_PRICE_/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/config/__tests__/worker.test.ts`
Expected: FAIL ("Cannot find module '../worker'").

- [ ] **Step 3: Implement `worker.ts`**

```typescript
// src/lib/config/worker.ts
//
// WORKER lane — Railway worker-process env. Self-loads .env.local before the
// first parse so a worker module imported outside worker/index.ts can't parse an
// empty env. Root schema is shape-only; getWorkerConfig is lazy + memoized.
// assertWorkerConfig mirrors worker/config/startup-assert.ts CORE_INFRA_REQUIRED_ENV
// (no more) so no env that boots today newly fails.
import { z } from 'zod';
import { STRIPE_PRICE_ENV_VARS } from '@/lib/payments/price-tier-map';
import { ensureWorkerDotenvLoaded } from './dotenv-load';

const nonEmpty = z.string().min(1);
const opt = z.string().min(1).optional();

const stripePriceShape = Object.fromEntries(
  STRIPE_PRICE_ENV_VARS.map((name) => [name, opt]),
) as Record<(typeof STRIPE_PRICE_ENV_VARS)[number], typeof opt>;

const workerSchema = z.object({
  DATABASE_POOL_URL: nonEmpty,
  SUPABASE_URL: nonEmpty,
  SUPABASE_SERVICE_KEY: nonEmpty,
  REDIS_QUEUE_URL: nonEmpty,
  // subsystem secrets (optional)
  STRIPE_SECRET_KEY: opt,
  STRIPE_WEBHOOK_SECRET: opt,
  ...stripePriceShape,
  RESEND_API_KEY: opt,
  SERPAPI_API_KEY: opt,
  OPENAI_API_KEY: opt,
  ANTHROPIC_API_KEY: opt,
  // shape-only optionals (presence owned by startup-assert.ts this Stage)
  REDIS_CACHE_URL: opt,
  ADMIN_NOTIFICATION_EMAIL: opt,
  SENTRY_DSN: opt,
  WORKER_PUBLIC_URL: opt,
  DATABASE_URL: opt,
});

export type WorkerConfig = z.infer<typeof workerSchema>;

export const WORKER_REQUIRED_VARS = [
  'DATABASE_POOL_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'REDIS_QUEUE_URL',
] as const;

let memo: WorkerConfig | undefined;

/** Lazy, memoized parse — self-loads dotenv first. NEVER at import time. */
export function getWorkerConfig(): WorkerConfig {
  if (!memo) {
    ensureWorkerDotenvLoaded();
    memo = workerSchema.parse(process.env);
  }
  return memo;
}

// Same carve-out as assertCoreInfraEnv: a no-op only in non-prod MOCK mode.
function mockSkip(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.MOCK_EXTERNAL_APIS === 'true';
}

function requirePresent(vars: readonly string[], subsystem: string): void {
  const missing = vars.filter((v) => {
    const value = process.env[v];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`[config] worker ${subsystem} requires: ${missing.join(', ')}`);
  }
}

/** Worker core-infra boot assert. Mirrors CORE_INFRA_REQUIRED_ENV. */
export function assertWorkerConfig(): void {
  ensureWorkerDotenvLoaded();
  if (mockSkip()) return;
  requirePresent(WORKER_REQUIRED_VARS, 'core-infra');
}

const STRIPE_WORKER_VARS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', ...STRIPE_PRICE_ENV_VARS] as const;

export interface WorkerStripeConfig {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_BASIC: string;
  STRIPE_PRICE_FOUNDING: string;
  STRIPE_PRICE_STANDARD: string;
  STRIPE_PRICE_PREMIUM: string;
  STRIPE_PRICE_STANDARD_OVERAGE: string;
  STRIPE_PRICE_PREMIUM_OVERAGE: string;
  STRIPE_PRICE_FOUNDERS_OVERAGE: string;
}

export function assertWorkerStripeConfig(): void {
  requirePresent(STRIPE_WORKER_VARS, 'stripe');
}
export function getWorkerStripeConfig(): WorkerStripeConfig {
  assertWorkerStripeConfig();
  const cfg = getWorkerConfig();
  return {
    STRIPE_SECRET_KEY: cfg.STRIPE_SECRET_KEY!,
    STRIPE_WEBHOOK_SECRET: cfg.STRIPE_WEBHOOK_SECRET!,
    STRIPE_PRICE_BASIC: cfg.STRIPE_PRICE_BASIC!,
    STRIPE_PRICE_FOUNDING: cfg.STRIPE_PRICE_FOUNDING!,
    STRIPE_PRICE_STANDARD: cfg.STRIPE_PRICE_STANDARD!,
    STRIPE_PRICE_PREMIUM: cfg.STRIPE_PRICE_PREMIUM!,
    STRIPE_PRICE_STANDARD_OVERAGE: cfg.STRIPE_PRICE_STANDARD_OVERAGE!,
    STRIPE_PRICE_PREMIUM_OVERAGE: cfg.STRIPE_PRICE_PREMIUM_OVERAGE!,
    STRIPE_PRICE_FOUNDERS_OVERAGE: cfg.STRIPE_PRICE_FOUNDERS_OVERAGE!,
  };
}

export function assertWorkerResendConfig(): void { requirePresent(['RESEND_API_KEY'], 'resend'); }
export function getWorkerResendConfig(): { RESEND_API_KEY: string } {
  assertWorkerResendConfig();
  return { RESEND_API_KEY: getWorkerConfig().RESEND_API_KEY! };
}

export function assertWorkerSerpapiConfig(): void { requirePresent(['SERPAPI_API_KEY'], 'serpapi'); }
export function getWorkerSerpapiConfig(): { SERPAPI_API_KEY: string } {
  assertWorkerSerpapiConfig();
  return { SERPAPI_API_KEY: getWorkerConfig().SERPAPI_API_KEY! };
}

export function assertWorkerOpenAiConfig(): void { requirePresent(['OPENAI_API_KEY'], 'openai'); }
export function getWorkerOpenAiConfig(): { OPENAI_API_KEY: string } {
  assertWorkerOpenAiConfig();
  return { OPENAI_API_KEY: getWorkerConfig().OPENAI_API_KEY! };
}

export function assertWorkerAnthropicConfig(): void { requirePresent(['ANTHROPIC_API_KEY'], 'anthropic'); }
export function getWorkerAnthropicConfig(): { ANTHROPIC_API_KEY: string } {
  assertWorkerAnthropicConfig();
  return { ANTHROPIC_API_KEY: getWorkerConfig().ANTHROPIC_API_KEY! };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/config/__tests__/worker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/config/worker.ts src/lib/config/__tests__/worker.test.ts
git commit -m "feat(config): worker lane (self-loads dotenv, core-infra assert, subsystem accessors)"
```

---

## Task 5: Import-safety test (the crisp no-import-time-secret proof) (TDD)

**Files:**
- Create: `src/lib/config/__tests__/import-safety.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// src/lib/config/__tests__/import-safety.test.ts
//
// THE crisp local proof that validation is not at import time: importing the
// server/worker config modules with ALL secrets cleared must NOT throw. If anyone
// re-introduces a top-level z.parse(), this test goes red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('config import-safety (no import-time secret dependency)', () => {
  const original = process.env;
  beforeEach(() => { process.env = {} as NodeJS.ProcessEnv; });
  afterEach(() => { process.env = original; vi.resetModules(); });

  it('importing config/server with a cleared env does not throw', async () => {
    await expect(import('../server')).resolves.toBeDefined();
  });

  it('importing config/worker with a cleared env does not throw', async () => {
    await expect(import('../worker')).resolves.toBeDefined();
  });

  it('importing config/client with a cleared env does not throw', async () => {
    await expect(import('../client')).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm test src/lib/config/__tests__/import-safety.test.ts`
Expected: PASS (3 tests) — confirms lazy parse.

- [ ] **Step 3: Commit**

```bash
git add src/lib/config/__tests__/import-safety.test.ts
git commit -m "test(config): import-safety proof (no import-time secret parse)"
```

---

## Task 6: Wire global asserts — instrumentation + worker boot (TDD where testable)

**Files:**
- Modify: `src/instrumentation.ts`
- Modify: `worker/index.ts`

- [ ] **Step 1: Wire `assertCoreAppConfig()` into instrumentation**

In `src/instrumentation.ts`, inside the existing `if (process.env.NEXT_RUNTIME === 'nodejs') { ... }` block, AFTER `Sentry.init({...})` and BEFORE the Stripe soft-assert, add:

```typescript
    // Core-app config gate (Stage 2): the minimum every Next server process
    // needs (Supabase URL/anon, app URL, server DB creds). Runs once per server
    // process at register(); nodejs-runtime-guarded so an edge split can't skip
    // or break it. Throws loudly on misconfig rather than failing the first
    // request with an opaque non-null deref.
    assertCoreAppConfig();
```

Add the import at the top (named import, not default):

```typescript
import { assertCoreAppConfig } from '@/lib/config/server';
```

- [ ] **Step 2: Wire `assertWorkerConfig()` into worker boot**

In `worker/index.ts`, add to the existing `assertX` import line from `./config/startup-assert` a SEPARATE import for the config assert (it lives in the config module, not startup-assert):

```typescript
import { assertWorkerConfig } from '../src/lib/config/worker';
```

Then, inside `start()` where the other asserts run (the `try { assertChannelsTelegramEnv(); ... }` block around line 301), add `assertWorkerConfig();` as the FIRST call in that try block:

```typescript
  try {
    assertWorkerConfig();
    assertChannelsTelegramEnv();
    assertChannelsWhatsAppEnv();
    assertSelfServeSignupEnv();
    assertZernioPublishingEnv();
    assertAccountOffboardingEnv();
    warnMissingProductionEnv();
```

> This runs AFTER `import './env'` (dotenv at file top) and is additive: it asserts the same four core-infra vars `assertCoreInfraEnv()` (already called via `startup-side-effect-guard`) asserts, with the same carve-out, so it cannot fail an env that boots today. The redundancy is intentional belt-and-suspenders for Stage 3 (when reads migrate to `getWorkerConfig()`).

- [ ] **Step 3: Typecheck + run the full config suite + lint**

Run: `pnpm typecheck && pnpm test src/lib/config && pnpm lint`
Expected: PASS. (Lint covers `src` only; `worker/index.ts` is typechecked.)

- [ ] **Step 4: Commit**

```bash
git add src/instrumentation.ts worker/index.ts
git commit -m "feat(config): wire assertCoreAppConfig (instrumentation) + assertWorkerConfig (worker boot)"
```

---

## Task 7: Prebuild client-config assert + no-secret build canary

**Files:**
- Create: `scripts/prebuild-assert-client-config.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Implement the prebuild script**

```typescript
// scripts/prebuild-assert-client-config.ts
//
// Runs assertClientConfig() before `next build` inlines NEXT_PUBLIC_*.  A missing
// required public var would otherwise be silently inlined as `undefined`; this
// fails the build loudly instead. Wired as the `prebuild` npm script (npm/pnpm run
// `prebuild` automatically before `build`).
import { assertClientConfig } from '../src/lib/config/client';

try {
  assertClientConfig();
  console.log('prebuild: client config OK');
} catch (err) {
  console.error(`prebuild: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
```

- [ ] **Step 2: Add the `prebuild` script to package.json**

In `package.json` `scripts`, add (pnpm runs `prebuild` automatically before `build`):

```json
    "prebuild": "tsx scripts/prebuild-assert-client-config.ts",
```

> The CI `lint`/`build` env block already sets the three required `NEXT_PUBLIC_*` vars, so `prebuild` passes in CI and the existing `build` job. Locally, `.env.local` supplies them.

- [ ] **Step 3: Add the no-secret build canary job to ci.yml**

Add a new job that builds with ONLY placeholder public env (no secrets), proving no import-time secret dependency crept in:

```yaml
  build-no-secrets:
    name: build-no-secrets-canary
    runs-on: ubuntu-latest
    timeout-minutes: 20
    # Deliberately a MINIMAL env: only the build-inlined NEXT_PUBLIC_* placeholders
    # and the server DB/auth creds Next needs at register(). NO subsystem secrets
    # (no STRIPE_*, RESEND_*, TWILIO_*, SERPAPI_*, OPENAI_*, ANTHROPIC_*). If the
    # build fails here, an import-time secret dependency has crept in.
    env:
      NEXT_PUBLIC_APP_URL: http://localhost:3000
      NEXT_PUBLIC_SUPABASE_URL: http://localhost:54321
      NEXT_PUBLIC_SUPABASE_ANON_KEY: dummy-anon-key-for-ci
      SUPABASE_URL: http://localhost:54321
      SUPABASE_SERVICE_KEY: dummy-service-key-for-ci
      DATABASE_POOL_URL: postgres://test:test@localhost:5432/test
    steps:
      - name: Checkout
        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6.0.3
        with:
          persist-credentials: false
      - name: Setup Node + pnpm
        uses: ./.github/actions/setup
      - name: Build with no secrets (canary)
        run: pnpm build
```

- [ ] **Step 4: Verify prebuild locally fails on a missing var**

Run: `cd <worktree> && env -i PATH="$PATH" pnpm exec tsx scripts/prebuild-assert-client-config.ts; echo "exit=$?"`
Expected: prints `prebuild: [config] client config invalid/missing: ...` and `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add scripts/prebuild-assert-client-config.ts package.json .github/workflows/ci.yml
git commit -m "ci(config): prebuild assertClientConfig + no-secret build canary"
```

---

## Task 8: Coverage audit — every required var asserted by exactly one lane (TDD)

**Files:**
- Create: `scripts/ci/config-coverage-baseline.ts`
- Create: `scripts/ci/config-coverage-audit.ts`
- Test: `scripts/ci/__tests__/config-coverage-audit.test.ts`

**Design.** The audit imports the three lanes' exported required-var lists (`CLIENT_REQUIRED_VARS`, `CORE_APP_REQUIRED_VARS`, `WORKER_REQUIRED_VARS`) plus the existing worker startup-required set (`CORE_INFRA_REQUIRED_ENV` is private to startup-assert.ts, so the baseline DECLARES the canonical required set + which lane(s) own each, and the audit checks the lane lists against that declaration). It asserts:
1. Every var in the declared canonical required set is asserted by ≥1 lane (no un-asserted required var).
2. No var is asserted by a lane it is NOT declared to belong to (no stray/double-assert in a wrong lane).
3. The declared set count equals `CONFIG_COVERAGE_BASELINE` (explicit reviewed bump on change).

Shared infra vars legitimately owned by BOTH server and worker are declared with both lanes — that is allowed, not a violation.

- [ ] **Step 1: Write the baseline declaration**

```typescript
// scripts/ci/config-coverage-baseline.ts
//
// The canonical set of UNCONDITIONALLY boot-required env vars and which config
// lane(s) own each. "Validate-all" is preserved by proving every entry here is
// asserted by at least one lane's boot assert, without one global parse. Shared
// infra (SUPABASE_URL/SUPABASE_SERVICE_KEY/DATABASE_POOL_URL) is owned by BOTH
// the server and worker processes because both read it via src/lib/db/server.ts.
//
// Changing this set requires bumping CONFIG_COVERAGE_BASELINE in the same PR.

export type ConfigLane = 'client' | 'server' | 'worker';

export interface RequiredVarDeclaration {
  var: string;
  lanes: readonly ConfigLane[];
}

export const REQUIRED_VAR_DECLARATIONS: readonly RequiredVarDeclaration[] = [
  // client-required trio (also server-needed for SSR; declared on both)
  { var: 'NEXT_PUBLIC_SUPABASE_URL', lanes: ['client', 'server'] },
  { var: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', lanes: ['client', 'server'] },
  { var: 'NEXT_PUBLIC_APP_URL', lanes: ['client', 'server'] },
  // server/worker shared infra (read by db/server.ts in both processes)
  { var: 'SUPABASE_URL', lanes: ['server', 'worker'] },
  { var: 'SUPABASE_SERVICE_KEY', lanes: ['server', 'worker'] },
  { var: 'DATABASE_POOL_URL', lanes: ['server', 'worker'] },
  // worker-only core infra
  { var: 'REDIS_QUEUE_URL', lanes: ['worker'] },
];

export const CONFIG_COVERAGE_BASELINE = REQUIRED_VAR_DECLARATIONS.length;
```

- [ ] **Step 2: Write the failing test**

```typescript
// scripts/ci/__tests__/config-coverage-audit.test.ts
import { describe, expect, it } from 'vitest';
import { auditConfigCoverage } from '../config-coverage-audit';
import { REQUIRED_VAR_DECLARATIONS } from '../config-coverage-baseline';

describe('config-coverage-audit', () => {
  it('passes for the real declarations + real lane lists', () => {
    expect(auditConfigCoverage()).toEqual([]);
  });

  it('flags a declared required var that no lane asserts', () => {
    const findings = auditConfigCoverage({
      declarations: [...REQUIRED_VAR_DECLARATIONS, { var: 'GHOST_VAR', lanes: ['worker'] }],
    });
    expect(findings.some((f) => f.includes('GHOST_VAR'))).toBe(true);
  });

  it('flags a var asserted by a lane it is not declared for', () => {
    const findings = auditConfigCoverage({
      workerRequired: ['DATABASE_POOL_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'REDIS_QUEUE_URL', 'STRAY_VAR'],
    });
    expect(findings.some((f) => f.includes('STRAY_VAR'))).toBe(true);
  });

  it('flags a baseline count mismatch', () => {
    const findings = auditConfigCoverage({ baseline: 999 });
    expect(findings.some((f) => f.includes('CONFIG_COVERAGE_BASELINE'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test scripts/ci/__tests__/config-coverage-audit.test.ts`
Expected: FAIL ("Cannot find module '../config-coverage-audit'").

- [ ] **Step 4: Implement the audit**

```typescript
// scripts/ci/config-coverage-audit.ts
//
// Proves "validate-all" without one global parse: every UNCONDITIONALLY
// boot-required env var (declared in config-coverage-baseline.ts) is asserted by
// at least one lane's boot assert, and no lane asserts a var it isn't declared to
// own. Pure auditConfigCoverage() is unit-tested; main() runs it for CI.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CLIENT_REQUIRED_VARS } from '../../src/lib/config/client';
import { CORE_APP_REQUIRED_VARS } from '../../src/lib/config/server';
import { WORKER_REQUIRED_VARS } from '../../src/lib/config/worker';
import {
  CONFIG_COVERAGE_BASELINE,
  REQUIRED_VAR_DECLARATIONS,
  type ConfigLane,
  type RequiredVarDeclaration,
} from './config-coverage-baseline';

interface AuditInput {
  declarations?: readonly RequiredVarDeclaration[];
  clientRequired?: readonly string[];
  coreAppRequired?: readonly string[];
  workerRequired?: readonly string[];
  baseline?: number;
}

export function auditConfigCoverage(input: AuditInput = {}): string[] {
  const declarations = input.declarations ?? REQUIRED_VAR_DECLARATIONS;
  const baseline = input.baseline ?? CONFIG_COVERAGE_BASELINE;
  const laneVars: Record<ConfigLane, ReadonlySet<string>> = {
    client: new Set(input.clientRequired ?? CLIENT_REQUIRED_VARS),
    server: new Set(input.coreAppRequired ?? CORE_APP_REQUIRED_VARS),
    worker: new Set(input.workerRequired ?? WORKER_REQUIRED_VARS),
  };
  const findings: string[] = [];

  if (declarations.length !== baseline) {
    findings.push(
      `declarations count ${declarations.length} != CONFIG_COVERAGE_BASELINE ${baseline} — bump the baseline in the same PR`,
    );
  }

  // (1) every declared required var is asserted by each lane it is declared for.
  const declaredByLane: Record<ConfigLane, Set<string>> = { client: new Set(), server: new Set(), worker: new Set() };
  for (const decl of declarations) {
    for (const lane of decl.lanes) {
      declaredByLane[lane].add(decl.var);
      if (!laneVars[lane].has(decl.var)) {
        findings.push(`${decl.var} is declared for lane '${lane}' but ${lane}'s required-var list does not assert it`);
      }
    }
  }

  // (2) no lane asserts a var it isn't declared to own.
  (Object.keys(laneVars) as ConfigLane[]).forEach((lane) => {
    for (const v of laneVars[lane]) {
      if (!declaredByLane[lane].has(v)) {
        findings.push(`lane '${lane}' asserts ${v} but it is not declared for that lane in config-coverage-baseline.ts`);
      }
    }
  });

  return findings;
}

function main(): void {
  const findings = auditConfigCoverage();
  if (findings.length > 0) {
    console.error('config-coverage-audit: failed');
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`config-coverage-audit: passed (${REQUIRED_VAR_DECLARATIONS.length} required vars, baseline ${CONFIG_COVERAGE_BASELINE})`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test scripts/ci/__tests__/config-coverage-audit.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the audit binary**

Run: `pnpm exec tsx scripts/ci/config-coverage-audit.ts`
Expected: `config-coverage-audit: passed (7 required vars, baseline 7)` and exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/ci/config-coverage-baseline.ts scripts/ci/config-coverage-audit.ts scripts/ci/__tests__/config-coverage-audit.test.ts
git commit -m "ci(config): coverage audit — every required var asserted by exactly one lane"
```

---

## Task 9: process.env baseline guard (TDD)

**Files:**
- Create: `scripts/ci/process-env-baseline.ts`
- Create: `scripts/ci/process-env-audit.ts`
- Test: `scripts/ci/__tests__/process-env-audit.test.ts`

**Design.** Scope = `src/lib/**` + `worker/**` (mirrors the audit conventions: skip `__tests__`, `*.test.ts`, `*.spec.ts`, `node_modules`, `dist`, `.next`, `coverage`). **Allowlist** (sanctioned `process.env` home): `src/lib/config/**`, `worker/env.ts`, `worker/config/startup-assert.ts`. **Baseline** = the exact set of in-scope, non-allowlisted files that read `process.env` TODAY (committed). FAIL when a file NOT in the baseline AND NOT allowlisted reads `process.env`. The baseline shrinks to 0 across Stage 3 as reads migrate; an entry that no longer reads `process.env` must be removed (the audit flags stale baseline entries too, mirroring `findUnusedAllowlistEntries`).

> **`readFlag` note (Stage 4):** the shared `readFlag` primitive (Stage 4) will join the allowlist when it lands. Add a comment in `process-env-baseline.ts` marking that future allowlist addition.

- [ ] **Step 1: Write the pure scanner + audit skeleton test first**

```typescript
// scripts/ci/__tests__/process-env-audit.test.ts
import { describe, expect, it } from 'vitest';
import { fileReadsProcessEnv, isAllowlisted, evaluateFindings } from '../process-env-audit';

describe('process-env-audit (pure)', () => {
  it('detects a process.env read', () => {
    expect(fileReadsProcessEnv("const x = process.env.FOO;")).toBe(true);
  });
  it('ignores a comment that merely names process.env', () => {
    expect(fileReadsProcessEnv("// we used to read process.env.FOO here")).toBe(false);
  });
  it('allowlists the config home + worker/env.ts + startup-assert', () => {
    expect(isAllowlisted('src/lib/config/server.ts')).toBe(true);
    expect(isAllowlisted('worker/env.ts')).toBe(true);
    expect(isAllowlisted('worker/config/startup-assert.ts')).toBe(true);
    expect(isAllowlisted('src/lib/payments/stripe-client.ts')).toBe(false);
  });
  it('flags a NEW non-baseline file that reads process.env', () => {
    const findings = evaluateFindings({
      readingFiles: new Set(['src/lib/new-thing.ts']),
      baseline: new Set<string>(),
    });
    expect(findings.some((f) => f.includes('new-thing.ts'))).toBe(true);
  });
  it('flags a STALE baseline entry that no longer reads process.env', () => {
    const findings = evaluateFindings({
      readingFiles: new Set<string>(),
      baseline: new Set(['src/lib/old-thing.ts']),
    });
    expect(findings.some((f) => f.includes('old-thing.ts') && f.toLowerCase().includes('stale'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test scripts/ci/__tests__/process-env-audit.test.ts`
Expected: FAIL ("Cannot find module '../process-env-audit'").

- [ ] **Step 3: Implement the audit (pure helpers + main)**

```typescript
// scripts/ci/process-env-audit.ts
//
// Baseline guard: the sanctioned process.env home is src/lib/config/** (plus
// worker/env.ts and worker/config/startup-assert.ts). Every OTHER in-scope file
// (src/lib/**, worker/**) that reads process.env today is in PROCESS_ENV_BASELINE.
// CI fails when a NEW (non-baseline, non-allowlisted) file reads process.env, or
// when a baseline entry no longer reads it (stale — remove it). The baseline
// shrinks to 0 over Stage 3 as reads migrate onto the config accessors.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROCESS_ENV_BASELINE, isAllowlisted } from './process-env-baseline';

export { isAllowlisted };

const SCAN_DIRS = ['src/lib', 'worker'] as const;
const SCAN_EXT = /\.(?:ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage', '__fixtures__']);
const SKIP_FILE = /\.(?:test|spec)\.[cm]?tsx?$/;

// A genuine read: process.env.X or process.env['X'] on a non-comment line.
const PROCESS_ENV_ACCESS = /process\.env(?:\.\w+|\[)/;

function normalize(file: string): string {
  return file.split(sep).join('/');
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** True if any non-comment line reads process.env. Pure — unit-tested. */
export function fileReadsProcessEnv(text: string): boolean {
  return text.split('\n').some((line) => !isCommentLine(line) && PROCESS_ENV_ACCESS.test(line));
}

export interface EvaluateInput {
  readingFiles: ReadonlySet<string>;
  baseline?: ReadonlySet<string>;
}

/** Compare the live reading-file set against the baseline. Pure — unit-tested. */
export function evaluateFindings(input: EvaluateInput): string[] {
  const baseline = input.baseline ?? PROCESS_ENV_BASELINE;
  const findings: string[] = [];
  for (const file of input.readingFiles) {
    if (isAllowlisted(file)) continue;
    if (!baseline.has(file)) {
      findings.push(`${file} reads process.env but is NOT in PROCESS_ENV_BASELINE — route it through src/lib/config/* (Stage 3) instead of adding a new raw read`);
    }
  }
  for (const file of baseline) {
    if (!input.readingFiles.has(file)) {
      findings.push(`${file} is in PROCESS_ENV_BASELINE but no longer reads process.env — remove the stale baseline entry (the baseline shrinks to 0 over Stage 3)`);
    }
  }
  return findings;
}

async function collectFiles(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectFiles(join(dir, entry.name), root, out);
    } else if (entry.isFile() && SCAN_EXT.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      out.push(normalize(relative(root, join(dir, entry.name))));
    }
  }
}

export async function collectReadingFiles(root: string): Promise<Set<string>> {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) await collectFiles(resolve(root, dir), root, files);
  const reading = new Set<string>();
  for (const file of files) {
    if (isAllowlisted(file)) continue;
    if (fileReadsProcessEnv(await readFile(resolve(root, file), 'utf8'))) reading.add(file);
  }
  return reading;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const reading = await collectReadingFiles(root);
  const findings = evaluateFindings({ readingFiles: reading });
  if (findings.length > 0) {
    console.error('process-env-audit: failed');
    for (const f of findings) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`process-env-audit: passed (baseline ${PROCESS_ENV_BASELINE.size} files reading process.env outside the config home)`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('process-env-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Generate the committed baseline from the audit's own scan**

Write a temporary generator (delete after) OR add the baseline file with a placeholder, then regenerate. Concretely: create `scripts/ci/process-env-baseline.ts` with the allowlist + an EMPTY set first:

```typescript
// scripts/ci/process-env-baseline.ts
//
// Committed baseline: in-scope files (src/lib/**, worker/**) that read process.env
// TODAY, outside the sanctioned config home. Generated by the audit's own scan
// (do NOT hand-edit entries). Shrinks to 0 over Stage 3 as reads migrate onto the
// config accessors. Adding a NEW reader requires migrating it instead — that is
// the point of this guard.
//
// ALLOWLIST = the only sanctioned process.env homes. Stage 4 will add the shared
// `readFlag` primitive's module here when it lands.

const ALLOWLIST_PREFIXES = ['src/lib/config/'] as const;
const ALLOWLIST_FILES = new Set<string>(['worker/env.ts', 'worker/config/startup-assert.ts']);

export function isAllowlisted(file: string): boolean {
  return ALLOWLIST_PREFIXES.some((p) => file.startsWith(p)) || ALLOWLIST_FILES.has(file);
}

export const PROCESS_ENV_BASELINE: ReadonlySet<string> = new Set<string>([
  // populated in Step 5
]);
```

- [ ] **Step 5: Populate the baseline by running the scan**

Run a one-liner that prints the current reading set, then paste the sorted list into `PROCESS_ENV_BASELINE`:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-audit-stage2-config-foundation && pnpm exec tsx -e "import {collectReadingFiles} from './scripts/ci/process-env-audit'; collectReadingFiles(process.cwd()).then(s => console.log([...s].sort().map(f => \`  '\${f}',\`).join('\n')))"
```

Paste the output between the `new Set<string>([` and `])` markers. (Expected ~100 files — the count printed must match `PROCESS_ENV_BASELINE.size` in the pass message.)

- [ ] **Step 6: Run the audit binary to verify it passes against HEAD**

Run: `pnpm exec tsx scripts/ci/process-env-audit.ts`
Expected: `process-env-audit: passed (baseline N files ...)` exit 0. If it fails with "NOT in PROCESS_ENV_BASELINE", a file was missed — re-run Step 5.

- [ ] **Step 7: Run the unit tests**

Run: `pnpm test scripts/ci/__tests__/process-env-audit.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 8: Commit**

```bash
git add scripts/ci/process-env-baseline.ts scripts/ci/process-env-audit.ts scripts/ci/__tests__/process-env-audit.test.ts
git commit -m "ci(config): process.env baseline guard (no new raw reads outside config home)"
```

---

## Task 10: Wire the two audits into CI + add npm scripts

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add npm scripts**

In `package.json` `scripts`, after `ci:admin-aal2`:

```json
    "ci:config-coverage": "tsx scripts/ci/config-coverage-audit.ts",
    "ci:process-env": "tsx scripts/ci/process-env-audit.ts",
```

- [ ] **Step 2: Wire into the lint job**

In `.github/workflows/ci.yml`, in the `lint` job steps, after `Run admin AAL2 mutation gate audit`:

```yaml
      - name: Run config coverage audit
        run: pnpm ci:config-coverage
      - name: Run process.env baseline audit
        run: pnpm ci:process-env
```

- [ ] **Step 3: Verify both scripts run green**

Run: `pnpm ci:config-coverage && pnpm ci:process-env`
Expected: both print `passed`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json .github/workflows/ci.yml
git commit -m "ci(config): wire config-coverage + process-env audits into lint job"
```

---

## Task 11: vitest.setup dummy-env belt-and-suspenders

**Files:**
- Modify: `vitest.setup.ts`

The existing setup sets `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DATABASE_POOL_URL`. The config-accessor tests already manage their own env per-case (they snapshot/restore `process.env`), but add the public + queue vars so any future accessor-exercising test outside the config suite has a complete dummy env.

- [ ] **Step 1: Extend the dummy env block**

At the top of `vitest.setup.ts`, after the existing three assignments, add:

```typescript
process.env.NEXT_PUBLIC_SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'dummy-anon-key-for-tests';
process.env.NEXT_PUBLIC_APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
process.env.REDIS_QUEUE_URL =
  process.env.REDIS_QUEUE_URL ?? 'redis://localhost:6379/1';
```

> Uses `??` so an explicitly-set value (CI) wins; it only fills gaps. This is additive and cannot change any test that already sets these.

- [ ] **Step 2: Run the full test suite to confirm no regression**

Run: `pnpm test`
Expected: PASS (all existing + new config tests).

- [ ] **Step 3: Commit**

```bash
git add vitest.setup.ts
git commit -m "test(config): complete dummy-env fixture for accessor-exercising tests"
```

---

## Task 12: Full verify gate

- [ ] **Step 1: Run the complete gate**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-audit-stage2-config-foundation && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage && pnpm ci:process-env && pnpm ci:fallow
```

Expected: every command exits 0. `pnpm build` is slow (also exercises the prebuild client-config assert + canary import path). Report pass/fail per command. If any fails, STOP and report — never weaken a test/audit/assert to go green.

- [ ] **Step 2: Confirm branch + commits**

```bash
git log --oneline refactor/audit-stage2-config-foundation -12
git branch --show-current
```

Expected: branch is `refactor/audit-stage2-config-foundation`; the plan commit + per-task commits present. Do NOT push, PR, or merge.

---

## Self-review checklist (run before declaring done)

- [ ] No existing `process.env` read was migrated (the 101 baseline files still read raw — Stage 3 owns migration).
- [ ] No subsystem-assert call-site was wired into a subsystem entry (only `assertCoreAppConfig`, `assertWorkerConfig`, `assertClientConfig` are wired).
- [ ] No top-level `z.parse()` in any importable config module (import-safety test green).
- [ ] No `any`; the `!` narrowings are each guarded by a preceding throw.
- [ ] No new `NEXT_PUBLIC_*` companion flag added; no new runtime dep added (`zod`/`dotenv` already present).
- [ ] `assertWorkerConfig()` requires nothing beyond `CORE_INFRA_REQUIRED_ENV`; `assertCoreAppConfig()` requires only the six already-effectively-required server vars → no env that boots today newly fails.
- [ ] `assertCoreAppConfig()` is inside the `NEXT_RUNTIME === 'nodejs'` guard.
- [ ] Both audits wired into `lint`; canary job added; npm scripts present.

## Risks / open items for reviewer

- **`assertCoreAppConfig()` newly throwing on a misconfigured-but-currently-limping Next env.** Mitigated: the six vars are already dereferenced with `!` in `db/server.ts`/SSR auth on the first authenticated request, so any env missing them already fails today — we only move the failure earlier (and louder). A purely-static/marketing preview that never touches the DB *could* in principle boot today and now fail at `register()`. If that lane exists, the six-var set must be trimmed to the three `NEXT_PUBLIC_*` only — flag at review.
- **instrumentation runtime-guard:** `register()` fires once per server process before the first request on Vercel Fluid Compute; the `NEXT_RUNTIME === 'nodejs'` guard ensures an edge runtime split neither runs (and fails on absent server creds) nor is skipped on the nodejs side. Confirm no middleware/edge route is expected to serve without the core-app config.
- **process-env baseline count** is whatever the scan yields (~100–101); it is generated, not asserted against a hardcoded number, so it self-documents in the pass message.
