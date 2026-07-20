# Split Postgres Pools + Pool-Wait Observability — Implementation Plan (round 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Ticket:** #477 (wayfinder map #472). Intake: `.feature/intake.json`. Round-1 codex review + triage + #6 decision + capacity facts: `docs/reviews/feat-477-split-pg-pools-poolwait/plan-review-round1.md`.

**Goal:** Bulkhead the wedge-SAFE small-fan-out dashboard/KPI reads onto a right-sized dedicated Vercel Postgres.js client, raise the Railway worker pool to cover merged BullMQ concurrency (within the real backend-connection ceiling), and surface a bounded single-flight worker pool-wait/saturation metric in `/internal/queue-health`.

**Architecture:** Three seams. (1) `src/lib/db/server.ts` gains a second singleton `sqlRead` sized to the fan-out of the ONLY routes moved onto it (KPI 5-wave, `past-replies/draft-status` 1) so those waves run one-connection-per-query — the proven #505 non-wedge shape; heavier fan-out routes stay on `sql` (owned by the #505 pipelining audit). `closeAllPostgresClients` explicitly owns `sqlRead` shutdown. (2) `src/lib/shared/pool-wait.ts` probes the SHARED pool via a **single-flight** `sql.reserve()` timing (leak-safe, bounded, ≤1 outstanding reservation globally), reporting `{ waitMs, timedOut, saturating, max }`; wired into queue-health as a best-effort dep. (3) The Railway raise is env-only (`DB_POOL_MAX=20`), blessed against the measured **60-connection backend ceiling** (Micro tier, both envs) and validated by the burst-drill watching `pg_stat_activity`.

**Tech Stack:** Postgres.js 3.4.9 (Supabase Supavisor transaction pooler, :6543), Fastify queue-health, Next.js 16 route handlers, Vitest.

---

## Capacity facts (measured 2026-07-19 via Supabase MCP — the real ceiling)

- **prod + staging both: `max_connections = 60`, `superuser_reserved_connections = 3` → 57 usable backend connections. Micro compute tier, both envs.** Current usage low (prod 12/1 active; staging 17/1 active).
- Three DISTINCT limits (do not conflate — codex #4): (a) postgres.js client `max` = app-side ceiling per client; (b) Supavisor "Max Clients" = accepted client connections (~200); (c) **Postgres `max_connections = 60` = the BINDING backend ceiling.** Under transaction pooling, Supavisor multiplexes many clients onto ≤57 backend connections; the sum of **concurrently-active transactions** (not idle clients) across worker + all Vercel instances + health(2) must stay < 57.
- Therefore `DB_POOL_MAX=20` (worker) is plausibly safe (20 + health 2 + baseline ~12 + Vercel active < 57) but **tight** — it is NOT below `default_pool_size` that matters (transaction mode multiplexes), it is the 60-conn backend total. The staging burst-drill must monitor `pg_stat_activity` backend count, NOT treat the app-side `probePoolWait` as capacity proof. Supavisor backend `pool_size` is not SQL-queryable → confirm in the Supabase dashboard during the staging gate.

## Concurrency × pool arithmetic (re-check — record in env-vars.md + ADR)

Merged hot-four BullMQ concurrency on the shared worker pool: ingest 5 + generate 5 + notif 4 + publish 4 = **18** (`worker/index.ts:186–230`), exceeding the current `max:10`. This proves worker *concurrency* 18 > pool 10, i.e. the pool can queue under the #474 design burst — NOT that 18 backend connections are held (a job holds a connection only while its transaction is active). The health poller is already off the shared pool (dedicated `max:2`). Raise to `DB_POOL_MAX=20` (covers the hot-four + ~2 poller headroom) — bounded above by the 60-conn backend ceiling, so 20 is a deliberate, ceiling-aware choice, staging-validated. Vercel stays `max:3` (env-set). Code default stays `10`.

## The #505 wedge constraint (why the read scope is narrow — codex #6)

The #505 root cause (lab-notes 2026-07-18): concurrent `Promise.all` queries on one postgres.js client over the Supavisor **transaction** pooler pipeline onto shared connections and wedge PERMANENTLY in `ClientRead` when fan-out > open connections (query-mix dependent). Proven: 6-query `Promise.all` on `max:2` wedged 6/6; the same 6 with `max:6` (one conn/query) wedged 0/6. The `fix-505-...-pipelining-audit-ticket.md` already lists the Vercel dashboard/KPI routes as candidate sites, deferred (each needs its own differential-repro; "don't fix-by-analogy"; a Vercel wedge is catastrophic).

**Decision (user, #6 → "right-size + narrow"):** move onto `sqlRead` ONLY the routes whose fan-out ≤ the read pool, so they run one-connection-per-query (the proven 0/6 shape):
- `GET /api/dashboard/kpis` — `getLocationKpiSummary`/`getAccountKpiSummary` fire a **5-query** `Promise.all` (`kpi/service.ts:178,283`); plus the subscription gate SELECT runs concurrently → ≤6 peak. `sqlRead max=8` ≥ 6. SAFE.
- `GET /api/dashboard/past-replies/draft-status` — single read of `job_outbox.payload`. SAFE.
- **LEAVE on write `sql`** (fan-out > 8; #505-audit owns them): `src/app/api/dashboard/route.ts` (~14-wave, +nested 5), `agent-team`, and the aggregate path (`aggregate-queries.ts` 8-wave). Moving them would perpetuate the wedge shape.

**Honesty (ADR):** `sqlRead` shares the same `DATABASE_POOL_URL`/user/db/transaction-mode as `sql`, so it draws from the SAME Supavisor backend pool. The bulkhead isolates only LOCAL postgres.js client slots (heavy reads can't consume the 3 write slots); it does NOT isolate backend DB capacity — a slow read still consumes a backend connection + DB CPU.

## Surface amendments (folded into `.feature/intake.json` round 2 — need sign-off)

- `worker/internal/pool-wait.ts` → `src/lib/shared/pool-wait.ts` (matches `backlog-depth.ts` precedent).
- `past-replies/**` → only `past-replies/draft-status/route.ts` (rest are write routes).
- Removed `src/app/api/dashboard/route.ts` + `agent-team/route.ts` (not moved — #6).
- Added `src/lib/config/server.ts` (own the new `DB_READ_POOL_MAX` in the config schema — #9).

## File Structure

- `src/lib/db/server.ts` — MODIFY: `readReadPoolMax()`, `sqlRead` (max 8, drop app_name-attribution claim), `SHARED_POOL_MAX` export, `sqlRead.end()` in `closeAllPostgresClients`.
- `src/lib/config/server.ts` — MODIFY: declare `DB_READ_POOL_MAX` (optional) in the schema next to `DB_POOL_MAX`.
- `src/lib/shared/pool-wait.ts` — CREATE: `probePoolWait` + single-flight wrapper + `PoolWait` type + defaults.
- `worker/internal/queue-health.ts` — MODIFY: `getPoolWait` dep + `pool` in payload.
- `worker/index.ts` — MODIFY: wire `getPoolWait` (shared `sql`, `SHARED_POOL_MAX`).
- `src/app/api/dashboard/kpis/route.ts`, `src/app/api/dashboard/past-replies/draft-status/route.ts` — MODIFY: read via `sqlRead`.
- `src/app/api/admin/jobs/route.ts`, `src/app/admin/jobs/page.tsx` — MODIFY: pass + render `pool`.
- `.claude/reference/env-vars.md`, `docs/adr/0009-split-postgres-pools.md` — docs.

---

## Task 1: Read bulkhead — `sqlRead` (right-sized) + narrow read-route wiring

**Blocking edges:** none.

**Files:** Modify `src/lib/db/server.ts`, `src/lib/config/server.ts`, `src/app/api/dashboard/kpis/route.ts`, `src/app/api/dashboard/past-replies/draft-status/route.ts`. Test `src/lib/db/__tests__/server.test.ts`, `src/app/api/dashboard/kpis/__tests__/route.test.ts`.

- [ ] **Step 1: Failing test — `sqlRead` distinct + correctly-configured (assert `.options`, per the existing precedent at `server.test.ts:17–43`).**

```ts
import { sql, sqlRead, SHARED_POOL_MAX } from '../server';

describe('sqlRead read bulkhead', () => {
  it('is a distinct client instance from the write singleton', () => {
    expect(sqlRead).not.toBe(sql);
  });
  it('is sized >= the moved KPI fan-out and carries the tight read statement_timeout', () => {
    // postgres.js exposes `.options` publicly (types/index.d.ts).
    const opts = (sqlRead as unknown as { options: { max: number; connection: { statement_timeout?: number } } }).options;
    expect(opts.max).toBeGreaterThanOrEqual(8);
    expect(opts.connection.statement_timeout).toBe(8000);
  });
  it('exposes the shared write-pool max as a positive number', () => {
    expect(SHARED_POOL_MAX).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm vitest run src/lib/db/__tests__/server.test.ts`

- [ ] **Step 3: Implement in `server.ts`** (after the `sql` singleton):

```ts
// Resolved shared write-pool ceiling (env-tunable). Exported so the worker
// composition root hands it to the pool-wait probe without re-reading env.
export const SHARED_POOL_MAX = readPoolMax();

/**
 * Read-path pool ceiling. Sized to the fan-out of the routes that use it so
 * their Promise.all waves run one-connection-per-query (the proven #505
 * non-wedge shape): KPI is a 5-query wave (+gate = <=6 peak), so default 8.
 * Env-tunable — but keep it >= the widest fan-out ROUTED onto sqlRead, and
 * mind the 60-conn backend ceiling (ADR 0009). Do NOT route >8-fan-out routes
 * onto this client without raising max to match (or they wedge — #505).
 */
function readReadPoolMax(): number {
  const parsed = parseInt(process.env.DB_READ_POOL_MAX ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
}

/**
 * Dedicated READ client (bulkhead) for the wedge-safe small-fan-out
 * dashboard/KPI read routes. Distinct LOCAL pool from `sql`, so a heavy read
 * wave can't consume the write client's slots. Same DATABASE_POOL_URL — it
 * shares the SAME Supavisor backend pool (isolation is LOCAL slots only, NOT
 * backend capacity; ADR 0009). Tighter 8s read statement_timeout.
 * `application_name` is client intent only — Supavisor flattens it to
 * 'Supavisor' server-side (ADR 0007), so it is NOT an attribution mechanism.
 * Lazy: postgres.js connects on first query; the worker imports this module
 * but never queries sqlRead, so zero connections there.
 */
export const sqlRead = createDedicatedPostgresClient(process.env.DATABASE_POOL_URL!, {
  max: readReadPoolMax(),
  connection: { application_name: 'repworth_reads', statement_timeout: 8000 },
});
```

Then extend `closeAllPostgresClients` to own `sqlRead` shutdown (codex #5 — no fragile "unused so never close" assumption). Add after the dedicated closers, before/alongside `sql.end()`:

```ts
  await Promise.allSettled(dedicatedClosers.map((close) => close()));
  await Promise.allSettled([sqlRead.end(), sql.end()]);
```
(Harmless no-op on the worker where `sqlRead` never connected; correct if any future path uses it. Vercel has no shutdown — `sqlRead` idle-reaps like `sql`.)

- [ ] **Step 4: Declare `DB_READ_POOL_MAX` in `src/lib/config/server.ts`** next to `DB_POOL_MAX` (line ~143), same `opt` shape (optional). This keeps the config schema the single owner of pool env vars (codex #9). `server.ts` still reads `process.env.DB_READ_POOL_MAX` directly, exactly as `readPoolMax` reads `DB_POOL_MAX` today — the schema declaration is for validation/inventory parity, not a behavior change.

- [ ] **Step 5: Run — expect PASS.** `pnpm vitest run src/lib/db/__tests__/server.test.ts`

- [ ] **Step 6: Failing test — KPI route reads via `sqlRead`.** In `kpis/__tests__/route.test.ts` (follow its existing `@/lib/db/server` + `@/lib/kpi/service` mock style): assert `getLocationKpiSummary`/`getAccountKpiSummary` receive `sqlRead` as their first arg, and the subscription-gate SELECT runs on `sqlRead`.

- [ ] **Step 7: Run — expect FAIL.** `pnpm vitest run src/app/api/dashboard/kpis/__tests__/route.test.ts`

- [ ] **Step 8: Wire `sqlRead` into `kpis/route.ts`.** Import `sqlRead`; replace every read use of `sql` (gate SELECT + both `get*KpiSummary` calls) with `sqlRead`. Route is read-only.

- [ ] **Step 9: Run — expect PASS.** `pnpm vitest run src/app/api/dashboard/kpis/__tests__/route.test.ts`

- [ ] **Step 10: Move `past-replies/draft-status/route.ts` reads to `sqlRead`.** This route only reads `job_outbox.payload` (JSONB-allowlist read site) — swap `sql` → `sqlRead`, update its route test's assertion. **Do NOT touch** any other `past-replies` route (all writes) or `dashboard/route.ts`/`agent-team` (heavy fan-out — #505-audit owned).

- [ ] **Step 11: Gate + commit.** `pnpm ci:db-imports && pnpm ci:tenant-scope`
```bash
git add src/lib/db/server.ts src/lib/config/server.ts src/lib/db/__tests__/server.test.ts src/app/api/dashboard/kpis src/app/api/dashboard/past-replies/draft-status
git commit -m "feat(#477): right-sized sqlRead bulkhead for wedge-safe KPI/draft-status reads"
```

---

## Task 2: Single-flight pool-wait probe (`src/lib/shared/pool-wait.ts`)

**Blocking edges:** none. **Blocks Task 3.**

**Files:** Create `src/lib/shared/pool-wait.ts`, `src/lib/shared/__tests__/pool-wait.test.ts`.

Design (addresses codex #2 blocker + #3 should-fix):
- **Single-flight**: a module-level `inflight` promise ensures ≤1 outstanding `reserve()` globally, so repeated queue-health hits (admin polls every 30s, or two concurrent admins) can NEVER accumulate reservations in postgres.js's internal queue under a wedge.
- **Honest semantics**: report `timedOut: boolean`; on timeout `waitMs` is the timeout value = a censored lower bound (label `>=` in the UI). `waitMs` may include connection-establishment latency (not pure queue wait) — documented; the `saturating` threshold is staging-calibrated, not a magic constant baked as truth.

- [ ] **Step 1: Failing tests** (fake `sql` with controllable `reserve()`):

```ts
import { probePoolWait, __resetPoolWaitInflight } from '../pool-wait';

function fakeSql(reserveImpl: () => Promise<{ release: () => void }>) {
  return { reserve: reserveImpl } as unknown as import('postgres').Sql;
}
beforeEach(() => __resetPoolWaitInflight());

it('free pool → low waitMs, not timedOut, not saturating, releases once', async () => {
  const release = vi.fn();
  const r = await probePoolWait(fakeSql(async () => ({ release })), { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 });
  expect(r).toMatchObject({ timedOut: false, saturating: false, max: 20 });
  expect(r.waitMs).toBeLessThan(50);
  expect(release).toHaveBeenCalledTimes(1);
});

it('timeout → timedOut:true, saturating:true, waitMs=timeout, late connection still released (no leak)', async () => {
  const release = vi.fn();
  let resolveReserve!: (v: { release: () => void }) => void;
  const r = await probePoolWait(fakeSql(() => new Promise((res) => { resolveReserve = res; })), { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 });
  expect(r).toMatchObject({ waitMs: 20, timedOut: true, saturating: true });
  resolveReserve({ release }); await Promise.resolve(); await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);
});

it('single-flight: concurrent probes share ONE reserve() (≤1 outstanding)', async () => {
  const reserve = vi.fn(async () => ({ release: vi.fn() }));
  const s = fakeSql(reserve);
  await Promise.all([probePoolWait(s, { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 }), probePoolWait(s, { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 })]);
  expect(reserve).toHaveBeenCalledTimes(1);
});

it('genuine reserve() rejection is re-thrown (handler maps to pool:null)', async () => {
  await expect(probePoolWait(fakeSql(async () => { throw new Error('refused'); }), { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 })).rejects.toThrow('refused');
});
```

- [ ] **Step 2: Run — expect FAIL.** `pnpm vitest run src/lib/shared/__tests__/pool-wait.test.ts`

- [ ] **Step 3: Implement `pool-wait.ts`.**

```ts
// Single owner of shared-pool "pool-wait" measurement. Best-effort saturation
// probe: time how long sql.reserve() takes to hand back a connection, release
// immediately. Takes `postgres.Sql` as a parameter (invariant #15). Mirrors
// backlog-depth.ts (the queue-health data-source injection seam). Probes the
// SHARED pool on purpose (plan §"Capacity"); single-flight bounds it to ONE
// outstanding reservation globally so repeated endpoint hits can't accumulate
// queued reservations under a wedge (codex #2).
import type postgres from 'postgres';
import { withTimeout, TimeoutError } from './with-timeout';

export const DEFAULT_POOL_WAIT_TIMEOUT_MS = 1000;   // < backlog 4s < admin 5s abort
export const DEFAULT_POOL_SATURATING_MS = 50;       // staging-calibrated; not gospel

export interface PoolWait {
  /** ms waiting for reserve(); on timeout this is a CENSORED LOWER BOUND (>=). May include connect latency, not pure queue wait. */
  waitMs: number;
  /** true when reserve() did not resolve within timeoutMs (waitMs is then a floor). */
  timedOut: boolean;
  /** timedOut OR waitMs >= threshold. */
  saturating: boolean;
  /** the shared pool's configured max (context). */
  max: number;
}
export interface PoolWaitOptions { timeoutMs: number; saturatingThresholdMs: number; max: number; }

let inflight: Promise<PoolWait> | null = null;

/** TEST ONLY: clear the single-flight latch between cases. */
export function __resetPoolWaitInflight(): void { inflight = null; }

async function runProbe(sql: postgres.Sql, opts: PoolWaitOptions): Promise<PoolWait> {
  const start = Date.now();
  const reservation = sql.reserve();
  reservation.then((c) => c.release()).catch(() => { /* rejection surfaced below */ });
  try {
    await withTimeout(reservation, opts.timeoutMs, 'pool-wait-probe');
    const waitMs = Date.now() - start;
    return { waitMs, timedOut: false, saturating: waitMs >= opts.saturatingThresholdMs, max: opts.max };
  } catch (err) {
    if (err instanceof TimeoutError) return { waitMs: opts.timeoutMs, timedOut: true, saturating: true, max: opts.max };
    throw err;
  }
}

/**
 * Single-flight probe. If a probe is already outstanding, the caller awaits the
 * SAME one (no second reserve()). A genuine reserve() rejection propagates to
 * every awaiter and clears the latch. Callers degrade a rejection to pool:null.
 */
export function probePoolWait(sql: postgres.Sql, opts: PoolWaitOptions): Promise<PoolWait> {
  if (inflight) return inflight;
  inflight = runProbe(sql, opts).finally(() => { inflight = null; });
  return inflight;
}
```

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run src/lib/shared/__tests__/pool-wait.test.ts`

- [ ] **Step 5: Commit.**
```bash
git add src/lib/shared/pool-wait.ts src/lib/shared/__tests__/pool-wait.test.ts
git commit -m "feat(#477): single-flight leak-safe pool-wait probe (bounded reservations)"
```

---

## Task 3: Surface pool-wait in queue-health + admin panel

**Blocking edges:** requires Task 2.

**Files:** Modify `worker/internal/queue-health.ts`, `worker/index.ts`, `src/app/api/admin/jobs/route.ts`, `src/app/admin/jobs/page.tsx`. Test `worker/internal/__tests__/queue-health.test.ts`.

- [ ] **Step 1: Failing test** — handler returns `pool: { waitMs, timedOut, saturating, max }` when `getPoolWait` resolves; `pool: null` when it rejects, while `queues` + `backlog` still return (independent degrade). Extend the deps mock with `getPoolWait`.

- [ ] **Step 2: Run — expect FAIL.** `pnpm vitest run worker/internal/__tests__/queue-health.test.ts`

- [ ] **Step 3: Extend the handler.** Add to `QueueHealthDeps`:
```ts
  /** Best-effort single-flight shared-pool saturation probe. Rejects → pool:null. */
  getPoolWait: () => Promise<import('../../src/lib/shared/pool-wait').PoolWait>;
```
Start it alongside backlog (overlaps the queue loop; rejection handled immediately):
```ts
    const poolResult: Promise<PoolWait | null> = deps.getPoolWait().catch((err: unknown) => {
      logger.warn('queue-health pool-wait unavailable', toError(err));
      return null;
    });
```
Send: `const pool = await poolResult;` … `reply.code(200).send({ queues, backlog, pool });`
(The probe self-bounds via its own `withTimeout` and reports `timedOut:true` on saturation — the handler only `.catch`es genuine errors → null; a saturation timeout is NOT null.)

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run worker/internal/__tests__/queue-health.test.ts`

- [ ] **Step 5: Wire in `worker/index.ts`.** Import `probePoolWait`, `DEFAULT_POOL_WAIT_TIMEOUT_MS`, `DEFAULT_POOL_SATURATING_MS` from `../src/lib/shared/pool-wait`, `SHARED_POOL_MAX` from the db-server import. In `createQueueHealthHandler({ ... })`:
```ts
      getPoolWait: () => probePoolWait(sql, {
        timeoutMs: DEFAULT_POOL_WAIT_TIMEOUT_MS,
        saturatingThresholdMs: DEFAULT_POOL_SATURATING_MS,
        max: SHARED_POOL_MAX,
      }),
```
**Use the shared `sql`** (NOT `healthBulkheadSql()`) — the probe must measure the pool the workers contend for.

- [ ] **Step 6: Pass `pool` through the admin route** (`src/app/api/admin/jobs/route.ts`). Add `pool: PoolWaitPayload | null` to `JobsData` with a LOCAL `type PoolWaitPayload = { waitMs: number; timedOut: boolean; saturating: boolean; max: number }` (the route can't import worker code — same locally-typed pattern as `queueHealth`). In `fetchQueueHealth`, also read `body.pool` and return it; on any fetch failure `pool` degrades to `null` alongside the existing `{unavailable:true}`.

- [ ] **Step 7: Render in `src/app/admin/jobs/page.tsx`.** Add a small read-only badge near the queue-depth/backlog display: show `pool.waitMs` ms (prefix `≥` when `pool.timedOut`), warning style when `pool.saturating`, and the panel's existing "unavailable" treatment when `pool` is null. No new component — reuse the existing badge styling.

- [ ] **Step 8: Gate + commit.**
```bash
pnpm vitest run worker/internal/__tests__/queue-health.test.ts src/app/api/admin/jobs
git add worker/internal/queue-health.ts worker/index.ts src/app/api/admin/jobs src/app/admin/jobs/page.tsx worker/internal/__tests__/queue-health.test.ts
git commit -m "feat(#477): surface single-flight pool-wait/saturation in queue-health + admin jobs"
```

---

## Task 4: Raise Railway pool (env + docs + ADR 0009)

**Blocking edges:** docs independent; staging-verify after Task 3 deploys.

**Files:** Modify `.claude/reference/env-vars.md`; create `docs/adr/0009-split-postgres-pools.md` (**0007 + 0008 are taken — codex #7**).

- [ ] **Step 1: `env-vars.md`.** Document `DB_POOL_MAX=20` (Railway staging+prod; Vercel stays 3) and the new `DB_READ_POOL_MAX` (default 8, Vercel; must stay ≥ the fan-out of any route routed onto `sqlRead`). Include the concurrency×pool arithmetic AND the measured capacity facts (60-conn backend ceiling / Micro tier / the 3-limit hierarchy).

- [ ] **Step 2: ADR 0009.** Capture: (a) separate-client-instance over sizing-alone — LOCAL write-slot isolation (NOT backend isolation: `sqlRead` shares the Supavisor backend pool; honest scope); (b) read scope narrowed to wedge-safe fan-out ≤ pool (KPI, draft-status), heavy waves deferred to the #505 pipelining audit; (c) pool-wait probe measures the shared pool intentionally, single-flight bounded, `timedOut` is a censored lower bound, threshold staging-calibrated, and it CANNOT validate the Supavisor/backend ceiling; (d) `application_name` is NOT attribution (ADR 0007 — Supavisor flattens it); (e) the measured 60-conn backend ceiling and why `DB_POOL_MAX=20` is a ceiling-aware choice; (f) pool-wait ALERTING deferred (HealthAlertPoller integration) as a follow-up.

- [ ] **Step 3: Commit.**
```bash
git add .claude/reference/env-vars.md docs/adr/0009-split-postgres-pools.md
git commit -m "docs(#477): pool-split arithmetic + measured 60-conn ceiling, DB_POOL_MAX=20, ADR 0009"
```

- [ ] **Step 4 (ship-time, feature step 8):** set `DB_POOL_MAX=20` on Railway **staging**, redeploy, run the #480/#505 burst-drill with the pool-wait metric live AND a `pg_stat_activity` backend-connection watch (the app-side probe is NOT capacity proof). Confirm `saturating` stays false at the design burst and backend connections stay well under 57. Record observed numbers in ADR 0009. Land the staging-proven number on prod Railway at promotion.

---

## Blocking edges

```
Task 1 (sqlRead)     ─┐
Task 2 (probe) ──► Task 3 (queue-health + admin)
Task 4 (docs) ── independent; staging-verify after Task 3 deploys
```

## How each round-1 codex finding is addressed

| # | Fix in plan |
|---|---|
| 1 | leak-safety kept (Task 2 step 3) |
| 2 | single-flight latch → ≤1 outstanding reservation (Task 2) |
| 3 | `timedOut` flag + censored-lower-bound labeling + staging-calibrated threshold (Task 2, Task 3 step 7, ADR) |
| 4 | measured 60-conn ceiling + 3-limit hierarchy + Vercel budget + burst-drill watches pg_stat_activity (Capacity §, Task 4) |
| 5 | `sqlRead.end()` in `closeAllPostgresClients` (Task 1 step 3) |
| 6 | narrow to wedge-safe fan-out (KPI/draft-status), `max:8 ≥ fan-out`, heavy waves left to #505 audit, honest local-only ADR (§#505, Task 1, Task 4) |
| 7 | ADR **0009**; `application_name` demoted to client-intent-only (Task 1 step 3, Task 4) |
| 8 | intake amended round 2 (surface + non-goals + behavior) — sign-off pending |
| 9 | `DB_READ_POOL_MAX` in `config/server.ts` (Task 1 step 4); `.options` assertions in server.test (Task 1 step 1) |

## Self-Review
- **Spec coverage:** (a) raise → Task 4; (b) read pool → Task 1 (narrowed, right-sized); (c) metric → Tasks 2+3. Invariant #15 → composition-root wiring only. All `tests_to_add` mapped.
- **Placeholder scan:** none — probe/server/handler code complete; UI/route steps name exact precedents.
- **Type consistency:** `PoolWait { waitMs, timedOut, saturating, max }` identical across Task 2/3 and the locally-mirrored `PoolWaitPayload`; `probePoolWait(sql, opts)` arity consistent; `SHARED_POOL_MAX` exported (T1) + consumed (T3).
