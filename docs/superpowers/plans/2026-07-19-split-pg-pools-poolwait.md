# Split Postgres Pools + Pool-Wait Observability — Implementation Plan (round 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Ticket:** #477 (wayfinder map #472). Intake: `.feature/intake.json`. Codex reviews + triage + #6 decision + measured capacity facts: `docs/reviews/feat-477-split-pg-pools-poolwait/plan-review-round1.md` + `plan-review-round2.md`.

**Goal:** Bulkhead the wedge-SAFE small-fan-out dashboard/KPI reads onto a right-sized dedicated Vercel Postgres.js client, raise the Railway worker pool to cover merged BullMQ concurrency (within the real backend-connection ceiling), and surface a bounded single-flight worker pool-wait/saturation metric in `/internal/queue-health`.

**Architecture:** Three seams. (1) `src/lib/db/server.ts` gains a second singleton `sqlRead`, floored at a fan-out-safe `max:8`, hosting ONLY the small-fan-out reads (KPI ≤6 concurrent; `past-replies/draft-status` ≤2 concurrent / up to 4 reads/request) so those waves run one-connection-per-query — the proven #505 non-wedge shape; heavier fan-out routes stay on `sql` (owned by the #505 pipelining audit). `closeAllPostgresClients` explicitly owns `sqlRead` shutdown. (2) `src/lib/shared/pool-wait.ts` probes the SHARED pool via a **single-flight** `sql.reserve()` timing (leak-safe, rejection-safe, ≤1 outstanding reservation globally), reporting `{ waitMs, timedOut, saturating, max }`; wired into queue-health as a best-effort dep. (3) The Railway raise is env-only (`DB_POOL_MAX=20`), sized against the measured **57 usable backend connections** (Nano/free tier, both envs) and **blessed only by the hard staging gate** (burst-drill watching `pg_stat_activity`).

**Tech Stack:** Postgres.js 3.4.9 (Supabase Supavisor transaction pooler, :6543), Fastify queue-health, Next.js 16 route handlers, Vitest.

---

## Capacity facts (measured 2026-07-19 via Supabase MCP — the real ceiling)

- **prod + staging both: `max_connections = 60`, `superuser_reserved_connections = 3`, `reserved_connections = 0` (PG17) → 57 usable backend connections.** Org plan = **free → Nano compute tier** (NOT Micro — the tier can't be inferred from `max_connections=60`, which is identical on Nano+Micro). Current usage low (prod 12/1 active; staging 17/1 active).
- Three DISTINCT limits — ALL can bind independently (do not conflate — codex #4/#12): (a) postgres.js client `max` = app-side ceiling per client; (b) **Supavisor "Max Clients" ≈ 200** = accepted client connections; (c) **Postgres `max_connections = 60` → 57 usable** = backend session ceiling; (d) Supavisor backend `pool_size` = how many backend sessions Supavisor opens (NOT SQL-queryable — confirm in the Supabase dashboard at the staging gate). Backend sessions — **active OR idle** — each consume a `max_connections` slot; do not model this as "active transactions only."
- **Numeric Vercel Max-Clients budget:** at proposed maxima one fully-expanded Vercel isolate owns write 3 + read 8 = **11** client connections. Worker 20 + health 2 + isolates × 11 ≤ 200 → **≤ 16 warm Vercel isolates**. Peak is 10 concurrent dashboard renders (#474) and Fluid Compute packs several renders per isolate, so ≤16 is comfortable — but it IS a bound. If warm isolates could approach it, the levers are: raise the Supabase compute tier (higher Max-Clients) or lower `DB_POOL_MAX` — NOT lower `DB_READ_POOL_MAX`, which is floored at 8 for wedge-safety and cannot go below it. Record the observed warm-isolate count at the staging gate.
- **`DB_POOL_MAX=20` is NOT "blessed" until the staging gate.** It is a ceiling-aware STARTING value (20 + health 2 + baseline + Vercel backend share, all multiplexed by Supavisor onto ≤57 backend sessions). The staging burst-drill is a HARD pre-production decision gate: monitor `pg_stat_activity` backend-session count (active AND idle) + the Supavisor `pool_size` from the dashboard; the app-side `probePoolWait` is NOT capacity proof. Land the drill-proven number.

## Concurrency × pool arithmetic (re-check — record in env-vars.md + ADR)

Merged hot-four BullMQ concurrency on the shared worker pool: ingest 5 + generate 5 + notif 4 + publish 4 = **18** (`worker/index.ts:186–230`), exceeding the current `max:10`. This proves worker *concurrency* 18 > pool 10, i.e. the pool can queue under the #474 design burst — NOT that 18 backend connections are held (a job holds a connection only while its transaction is active). The health poller is already off the shared pool (dedicated `max:2`). Raise to `DB_POOL_MAX=20` (covers the hot-four + ~2 poller headroom) — bounded above by the 60-conn backend ceiling, so 20 is a deliberate, ceiling-aware choice, staging-validated. Vercel stays `max:3` (env-set). Code default stays `10`.

## The #505 wedge constraint (why the read scope is narrow — codex #6)

The #505 root cause (lab-notes 2026-07-18): concurrent `Promise.all` queries on one postgres.js client over the Supavisor **transaction** pooler pipeline onto shared connections and wedge PERMANENTLY in `ClientRead` when fan-out > open connections (query-mix dependent). Proven: 6-query `Promise.all` on `max:2` wedged 6/6; the same 6 with `max:6` (one conn/query) wedged 0/6. The `fix-505-...-pipelining-audit-ticket.md` already lists the Vercel dashboard/KPI routes as candidate sites, deferred (each needs its own differential-repro; "don't fix-by-analogy"; a Vercel wedge is catastrophic).

**Decision (user, #6 → "right-size + narrow"):** move onto `sqlRead` ONLY the routes whose fan-out ≤ the read pool, so they run one-connection-per-query (the proven 0/6 shape):
- `GET /api/dashboard/kpis` — `getLocationKpiSummary`/`getAccountKpiSummary` fire a **5-query** `Promise.all` (`kpi/service.ts:178,283`); plus the subscription gate SELECT runs concurrently → ≤6 peak. `sqlRead max=8` ≥ 6. SAFE.
- `GET /api/dashboard/past-replies/draft-status` — peak postgres.js fan-out 2 (the `resolveOwnerScope` auth preamble runs account-gate + location-scope concurrently), up to 4 SQL reads over the request. ≤8. SAFE. (Auth preamble stays on write `sql` — see Task 1 step 10.)
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
  it('floors DB_READ_POOL_MAX at the wedge-safe minimum — a mis-set 1 cannot reintroduce the #505 wedge (codex #6)', async () => {
    try {
      vi.resetModules();
      vi.stubEnv('DB_READ_POOL_MAX', '1');
      const fresh = await import('../server');
      expect((fresh.sqlRead as unknown as { options: { max: number } }).options.max).toBe(fresh.WEDGE_SAFE_READ_MIN);
    } finally {
      // cleanup in finally so a failed assertion can't leave the env stubbed / modules reset (codex nit)
      vi.unstubAllEnvs();
      vi.resetModules();
    }
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
// Wedge-safe minimum: the widest Promise.all fan-out ROUTED onto sqlRead
// (KPI ≤6) must run one-connection-per-query (#505). Config may RAISE but NEVER
// set below this floor, so a mis-set env cannot reintroduce the wedge (codex #6).
export const WEDGE_SAFE_READ_MIN = 8;
function readReadPoolMax(): number {
  const parsed = parseInt(process.env.DB_READ_POOL_MAX ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(WEDGE_SAFE_READ_MIN, parsed) : WEDGE_SAFE_READ_MIN;
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
  // sqlRead JOINS the best-effort closers (its .end() rejection can't skip
  // sql.end()); sql.end() stays AWAITED DIRECTLY so its rejection still
  // propagates — preserving the existing shutdown contract (codex #13).
  await Promise.allSettled([...dedicatedClosers.map((close) => close()), sqlRead.end()]);
  await sql.end();
```
(Harmless no-op on the worker where `sqlRead` never connected; correct if any future path uses it. Vercel has no shutdown — `sqlRead` idle-reaps like `sql`.) Add a lifecycle test asserting `sqlRead.end()` IS invoked AND that a rejecting `sql.end()` still propagates out of `closeAllPostgresClients` (mirror the existing `server.test.ts:52-92` close-order test).

- [ ] **Step 4: Declare `DB_READ_POOL_MAX` in `src/lib/config/server.ts`** next to `DB_POOL_MAX` (line ~143), same `opt` shape (optional). This keeps the config schema the single owner of pool env vars (codex #9). `server.ts` still reads `process.env.DB_READ_POOL_MAX` directly, exactly as `readPoolMax` reads `DB_POOL_MAX` today — the schema declaration is for validation/inventory parity, not a behavior change.

- [ ] **Step 5: Run — expect PASS.** `pnpm vitest run src/lib/db/__tests__/server.test.ts`

- [ ] **Step 6: Failing test — KPI route reads via `sqlRead`.** In `kpis/__tests__/route.test.ts` (follow its existing `@/lib/db/server` + `@/lib/kpi/service` mock style): assert `getLocationKpiSummary`/`getAccountKpiSummary` receive `sqlRead` as their first arg, and the subscription-gate SELECT runs on `sqlRead`.

- [ ] **Step 7: Run — expect FAIL.** `pnpm vitest run src/app/api/dashboard/kpis/__tests__/route.test.ts`

- [ ] **Step 8: Wire `sqlRead` into `kpis/route.ts`.** Import `sqlRead`; replace every read use of `sql` (gate SELECT + both `get*KpiSummary` calls) with `sqlRead`. Route is read-only.

- [ ] **Step 9: Run — expect PASS.** `pnpm vitest run src/app/api/dashboard/kpis/__tests__/route.test.ts`

- [ ] **Step 10: Move `past-replies/draft-status/route.ts` reads to `sqlRead`.** Fan-out inventory (codex #11 — record accurately): `resolveOwnerScope` runs the account-gate + location-scope lookups CONCURRENTLY (peak postgres.js fan-out = 2), plus a `getRequestScope` businesses query, then the `job_outbox.payload` read and (for completed jobs) a second response lookup — up to 4 SQL reads over the request, peak 2 concurrent. Safe at `max:8`. **Wiring decision (codex #4-wiring):** the shared `resolveOwnerScope` auth gate STAYS on write `sql` — it is a shared helper used by many routes; do NOT thread `sqlRead` through it. Move ONLY the route-body reads (`job_outbox.payload` + the completed-job response lookup) onto `sqlRead` (peak ≤2, and since auth is on `sql` the sqlRead peak here is ≤1). Apply the same rule to the KPI route (step 8): `withDashboardOwnerRead`/`resolveOwnerScope` stay on `sql`; only the gate SELECT + `get*KpiSummary` calls move to `sqlRead`. Update each route test's assertion to match. **Do NOT touch** any other `past-replies` route (all writes) or `dashboard/route.ts`/`agent-team` (heavy fan-out — #505-audit owned).

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
- **Honest semantics**: report `timedOut: boolean`; on timeout `waitMs` is the timeout value = a censored lower bound (label `>=` in the UI). `waitMs` may include connection-establishment latency (not pure queue wait) — documented; the `saturating` threshold ships as a PROVISIONAL default and is calibrated on staging (Task 4 step 4.2), not treated as final.

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

it('single-flight: concurrent probes over a PENDING reservation share ONE reserve()', async () => {
  const reserve = vi.fn(() => new Promise<{ release: () => void }>(() => { /* never resolves */ }));
  const s = fakeSql(reserve);
  await Promise.all([
    probePoolWait(s, { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 }),
    probePoolWait(s, { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 }),
  ]);
  expect(reserve).toHaveBeenCalledTimes(1); // both timed out; one reservation total
});

it('REGRESSION (#10): a timed-out call does NOT release the latch — the second call reuses the still-pending reserve(), released once on settlement', async () => {
  const release = vi.fn();
  let resolveReserve!: (v: { release: () => void }) => void;
  const reserve = vi.fn(() => new Promise<{ release: () => void }>((res) => { resolveReserve = res; }));
  const s = fakeSql(reserve);
  const first = await probePoolWait(s, { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 });
  expect(first.timedOut).toBe(true);                 // call 1 times out; reservation still pending
  const secondP = probePoolWait(s, { timeoutMs: 20, saturatingThresholdMs: 50, max: 20 });
  expect(reserve).toHaveBeenCalledTimes(1);          // call 2 REUSES it — NO new reserve() (no accumulation)
  expect((await secondP).timedOut).toBe(true);
  resolveReserve({ release });                        // reservation finally settles
  await Promise.resolve(); await Promise.resolve();
  expect(release).toHaveBeenCalledTimes(1);           // released exactly once
});

it('genuine reserve() rejection is re-thrown (handler maps to pool:null)', async () => {
  await expect(probePoolWait(fakeSql(async () => { throw new Error('refused'); }), { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 })).rejects.toThrow('refused');
});

it('REGRESSION (blocker): a rejecting reserve() with TWO concurrent awaiters emits NO unhandledRejection (the latch cleanup must not leave a derived rejected promise)', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectReserve!: (e: Error) => void;
    const s = fakeSql(() => new Promise<{ release: () => void }>((_, rej) => { rejectReserve = rej; }));
    const p1 = probePoolWait(s, { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 });
    const p2 = probePoolWait(s, { timeoutMs: 1000, saturatingThresholdMs: 50, max: 20 });
    rejectReserve(new Error('reserve-refused'));
    await expect(p1).rejects.toThrow('reserve-refused'); // both awaiters see it
    await expect(p2).rejects.toThrow('reserve-refused');
    await new Promise((r) => setTimeout(r, 0));           // let any stray rejection surface a tick
    expect(unhandled).toHaveLength(0);                    // the r.finally() shape would fail HERE
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
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
export const DEFAULT_POOL_SATURATING_MS = 50;       // PROVISIONAL default — calibrate on staging (Task 4 step 4); not final

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

// The latch is the RESERVATION promise itself, cleared ONLY when it SETTLES
// (resolve or reject) — NOT when a caller's bounded wait times out. So under a
// wedge, repeated callers reuse the ONE pending reserve() (no accumulation in
// postgres.js's internal queue — codex #2/#10), each racing it against their own
// withTimeout. release() is attached once, fires on settlement even if every
// caller has already timed out (leak-safe).
let inflightReservation: Promise<{ release: () => void }> | null = null;
let reservationStartMs = 0;

/** TEST ONLY: clear the reservation latch between cases. */
export function __resetPoolWaitInflight(): void { inflightReservation = null; }

function sharedReservation(sql: postgres.Sql): { reservation: Promise<{ release: () => void }>; startMs: number } {
  if (!inflightReservation) {
    reservationStartMs = Date.now();
    const r = sql.reserve() as unknown as Promise<{ release: () => void }>;
    // ONE caught chain: release on resolve, swallow the rejection (each caller
    // still observes r's rejection through its own withTimeout race on r), then
    // clear the latch on settlement. Do NOT attach a standalone `r.finally()` —
    // finally() returns a DERIVED promise that re-adopts r's rejection with no
    // handler, so a rejecting reserve() emits an unhandledRejection → the
    // worker crash-net's fatal path (worker/index.ts). Keeping the latch-clear
    // INSIDE the caught chain means the only promise deriving from a rejected r
    // is already handled.
    r.then((c) => c.release())
      .catch(() => { /* observed here; also surfaced to awaiters via their race on r */ })
      .finally(() => { inflightReservation = null; });
    inflightReservation = r;
  }
  return { reservation: inflightReservation, startMs: reservationStartMs };
}

/**
 * Best-effort pool-wait sample. Every caller gets an independently-bounded wait
 * (withTimeout) over the ONE shared reservation. Timeout → timedOut:true,
 * saturating:true, waitMs = timeoutMs (censored lower bound). A genuine
 * reserve() rejection propagates to every awaiter (handler → pool:null).
 */
export async function probePoolWait(sql: postgres.Sql, opts: PoolWaitOptions): Promise<PoolWait> {
  const { reservation, startMs } = sharedReservation(sql);
  try {
    await withTimeout(reservation, opts.timeoutMs, 'pool-wait-probe');
    const waitMs = Date.now() - startMs;
    return { waitMs, timedOut: false, saturating: waitMs >= opts.saturatingThresholdMs, max: opts.max };
  } catch (err) {
    if (err instanceof TimeoutError) return { waitMs: opts.timeoutMs, timedOut: true, saturating: true, max: opts.max };
    throw err;
  }
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

- [ ] **Step 3: Extend the handler.** First add a top-of-file import (the `poolResult` annotation below references the bare `PoolWait` name — codex #14): `import type { PoolWait } from '../../src/lib/shared/pool-wait';`. Then add to `QueueHealthDeps`:
```ts
  /** Best-effort single-flight shared-pool saturation probe. Rejects → pool:null. */
  getPoolWait: () => Promise<PoolWait>;
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

- [ ] **Step 1: `env-vars.md`.** Document `DB_POOL_MAX=20` (Railway staging+prod; Vercel stays 3) and the new `DB_READ_POOL_MAX` (default 8, Vercel; **code-floored at `WEDGE_SAFE_READ_MIN=8`** — can only raise). Include the concurrency×pool arithmetic AND the measured capacity facts (Nano/free tier, `max_connections=60`, `reserved_connections=0`, 57 usable, Max-Clients ≈200, the 4-limit hierarchy) AND the ≤16-warm-Vercel-isolate budget.

- [ ] **Step 2: ADR 0009.** Capture: (a) separate-client-instance over sizing-alone — LOCAL write-slot isolation (NOT backend isolation: `sqlRead` shares the Supavisor backend pool; honest scope); (b) read scope narrowed to wedge-safe fan-out ≤ pool (KPI, draft-status), heavy waves deferred to the #505 pipelining audit; (c) pool-wait probe measures the shared pool intentionally, single-flight over ONE reservation (latch follows reservation settlement — bounded accumulation), `timedOut` is a censored lower bound, threshold calibrated on staging (record warm/cold samples + chosen value), and it CANNOT validate the Supavisor/backend ceiling; (d) `application_name` is NOT attribution (ADR 0007 — Supavisor flattens it); (e) the MEASURED capacity: Nano/free tier, `max_connections=60`, `reserved_connections=0`, 57 usable, Max-Clients ≈200; idle backend sessions ALSO consume slots; the ≤16-warm-Vercel-isolate budget; why `DB_POOL_MAX=20` is a ceiling-aware STARTING value blessed only by the staging gate (with the recorded burst-drill / `pg_stat_activity` / Supavisor `pool_size` numbers); (f) pool-wait ALERTING deferred (HealthAlertPoller integration) as a follow-up.

- [ ] **Step 3: Commit.**
```bash
git add .claude/reference/env-vars.md docs/adr/0009-split-postgres-pools.md
git commit -m "docs(#477): pool-split arithmetic + measured 60-conn ceiling, DB_POOL_MAX=20, ADR 0009"
```

- [ ] **Step 4 (ship-time, feature step 8) — the HARD staging capacity + calibration gate:**
  1. Set `DB_POOL_MAX=20` on Railway **staging**, redeploy.
  2. **Threshold calibration (codex #3):** sample `probePoolWait` on an idle-then-warm pool: measure warm reserve() latency (repeated back-to-back) vs cold (first probe after > `idle_timeout` 30s reap). Set `DEFAULT_POOL_SATURATING_MS` ABOVE the warm p99 (so a warm checkout never reads as saturation) but below observed real queueing; record the chosen value + the warm/cold samples in ADR 0009.
  3. **Capacity gate (codex #4/#12):** run the #480/#505 burst-drill with the metric live; watch `pg_stat_activity` backend-session count (active AND idle), read the Supavisor backend `pool_size` from the Supabase dashboard, and record the observed warm-Vercel-isolate count against the ≤16 budget. Confirm backend sessions stay well under 57 and Max-Clients under 200.
  4. Land the drill-proven `DB_POOL_MAX` on prod Railway at promotion; record all observed numbers in ADR 0009. The app-side probe is NOT capacity proof — the `pg_stat_activity`/dashboard readings are.

- [ ] **Step 5 (final verification — codex #15):** after ALL tasks, run the full `/feature` step-5 gate `scripts/verify-gate.sh` — not only task-local vitest. Surface is `mixed`, so this runs `pnpm lint && pnpm typecheck && pnpm test && pnpm build` PLUS every `ci:*` audit (incl. `ci:db-imports`, `ci:tenant-scope`, `ci:static-policy`). Must be green before review.

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
| 3 | `timedOut` flag + censored-lower-bound labeling + PROVISIONAL threshold calibrated on staging (Task 2, Task 3 step 7, Task 4 step 4.2, ADR) |
| 4 | measured 60-conn ceiling + 3-limit hierarchy + Vercel budget + burst-drill watches pg_stat_activity (Capacity §, Task 4) |
| 5 | `sqlRead.end()` in `closeAllPostgresClients` (Task 1 step 3) |
| 6 | narrow to wedge-safe fan-out (KPI/draft-status), `max:8 ≥ fan-out`, heavy waves left to #505 audit, honest local-only ADR (§#505, Task 1, Task 4) |
| 7 | ADR **0009**; `application_name` demoted to client-intent-only (Task 1 step 3, Task 4) |
| 8 | intake amended round 2 (surface + non-goals + behavior) — sign-off pending |
| 9 | `DB_READ_POOL_MAX` in `config/server.ts` (Task 1 step 4); `.options` assertions in server.test (Task 1 step 1) |

## How each round-2 codex finding is addressed (round 3)

| # | Fix |
|---|---|
| 2/10 (blocker) | latch is now the RESERVATION promise, cleared only on settlement; each caller races it with its own withTimeout → ≤1 outstanding reserve() under a wedge; regression test added (Task 2) |
| 4/12 (blocker) | Nano/free tier (not Micro), `reserved_connections=0` → 57 usable; idle sessions counted; numeric ≤16-warm-isolate Vercel budget; DB_POOL_MAX=20 = ceiling-aware starting value blessed only by the hard staging gate (Capacity §, Task 4) |
| 6 (blocker) | `DB_READ_POOL_MAX` code-floored at `WEDGE_SAFE_READ_MIN=8` + floor test (Task 1) |
| 3 (should-fix) | 50ms = provisional; explicit warm/cold staging calibration procedure + recorded outcome (Task 4 step 4.2) |
| 8 (should-fix) | intake edge_cases + tests_to_add reconciled (see intake round-3) |
| 11 (should-fix) | draft-status fan-out inventory corrected: peak 2 concurrent / ≤4 reads (Task 1 step 10) |
| 13 (should-fix) | `sql.end()` stays awaited directly (propagates); sqlRead best-effort; closer test added (Task 1 step 3) |
| 14 (nit) | `import type { PoolWait }` added (Task 3 step 3) |
| 15 (should-fix) | explicit final `scripts/verify-gate.sh` full gate (Task 4 step 5) |

## Self-Review
- **Spec coverage:** (a) raise → Task 4; (b) read pool → Task 1 (narrowed, right-sized, floored); (c) metric → Tasks 2+3. Invariant #15 → composition-root wiring only. All `tests_to_add` mapped.
- **Placeholder scan:** none — probe/server/handler code complete; UI/route steps name exact precedents.
- **Type consistency:** `PoolWait { waitMs, timedOut, saturating, max }` identical across Task 2/3 and the locally-mirrored `PoolWaitPayload`; `probePoolWait(sql, opts)` arity consistent; `SHARED_POOL_MAX` exported (T1) + consumed (T3).
