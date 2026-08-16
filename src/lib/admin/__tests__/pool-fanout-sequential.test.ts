// src/lib/admin/__tests__/pool-fanout-sequential.test.ts
//
// #505 regression: the Vercel admin read paths MUST run their multi-query
// bundles SEQUENTIALLY, one query in flight at a time.
//
// WHY: these services share the singleton `sql` client, whose pool is
// `DB_POOL_MAX` = 3 on Vercel (src/lib/db/server.ts). Firing more concurrent
// queries than the pool has connections makes postgres.js pipeline the excess
// onto already-open connections over the Supabase Supavisor TRANSACTION pooler;
// a pipelined query's response then parks server-side in state=active /
// wait_event=ClientRead and is never read — a PERMANENT Connection wedge. No
// server-side timeout heals it (in ClientRead the statement is not executing, so
// `statement_timeout` never fires), so every render LEAKS a pool slot until the
// pool starves.
//
// Observed live on staging 2026-08-10: the admin portal was fully unusable —
// every admin PAGE returned 200 headers and then never finished streaming its
// body, while admin API routes stayed healthy. pg_stat_activity showed wedged
// backends held for >3 minutes, including this file's overview businesses query
// and cost-report's byDay query. That promoted these call sites from #505 audit
// SUSPECTS to confirmed instances.
//
// SEAM HONESTY: the pipelining effect itself is a live-pooler behavior a unit
// test CANNOT reproduce (there is no faithful seam without the real Supavisor
// pooler). The max-observed-concurrency === 1 assertion below is the closest
// unit-level PROXY for "sequential → nothing pipelines", exactly as the #505
// cure is guarded for runHealthChecks
// (worker/background/pollers/health-alert/__tests__/checks.test.ts). Do not
// mistake this green test for full proof of the cure.

import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { getAdminOverview } from '../overview-service';
import { getBusinessSummaries } from '../business-summary';
import {
  fetchBusinessDetailBatch1,
  fetchBusinessDetailBatch2,
} from '../business-detail/queries';

/**
 * A fake `sql` that records the peak number of simultaneously in-flight
 * queries, and how many were dispatched in total.
 *
 * Queries are LAZY THENABLES, matching the shared mock-sql harness: a tagged
 * template only counts as "in flight" once something calls `.then` on it, and
 * it resolves asynchronously (after a macrotask) so any overlap is observable.
 *
 * That laziness is what makes this fragment-safe. Nested `sql` fragments (e.g.
 * cost-report's `optionalAccountPrefix(sql, accountId)`) are built synchronously
 * as interpolated VALUES and never awaited, so they never call `.then` and never
 * inflate the count — only real dispatched queries do.
 *
 * Sequential execution keeps the peak at 1. A `Promise.all` of N queries calls
 * all N `.then`s in the same tick before any resolves → peak N.
 *
 * `rows` SEEDS the FIFO result queue, one entry per dispatched query in dispatch
 * order (a non-array entry is wrapped; an exhausted queue yields `[]`). Seeding
 * matters wherever the subject's later queries are CONDITIONAL on earlier
 * results: an unseeded harness returns no rows, the condition goes false, and
 * the peak is measured over a shorter bundle than the test claims. That is what
 * `getQueryCount` is for — pin the bundle LENGTH alongside its peak so a silent
 * skip can't masquerade as a passing sequencing guard.
 */
function makeConcurrencyTrackingSql(rows: unknown[] = []) {
  let inFlight = 0;
  let maxInFlight = 0;
  let dispatched = 0;
  const queue = [...rows];

  const sql = ((..._args: unknown[]) => ({
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      inFlight += 1;
      dispatched += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((settle) => setTimeout(settle, 0))
        .then(() => {
          inFlight -= 1;
          const next = queue.shift() ?? [];
          return Array.isArray(next) ? next : [next];
        })
        .then(resolve, reject);
    },
  })) as unknown as Sql & { json: (v: unknown) => unknown; begin: (cb: unknown) => unknown };

  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  (sql as unknown as { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin = (cb) =>
    Promise.resolve(cb(sql));

  return { sql, getMaxConcurrency: () => maxInFlight, getQueryCount: () => dispatched };
}

/**
 * One base-query row, complete enough for `buildBusinessSummary` to map it
 * without throwing. Its only job here is to make `businessIds` non-empty so the
 * conditional metrics CTE actually dispatches.
 */
function seedBusinessRow() {
  return {
    id: 'b1000000-0000-4000-8000-000000000001',
    name: 'Seed Cafe',
    category: null,
    subscription_status: 'active',
    last_sync_at: null,
    pending_approval_count: 0,
    pending_reconnect_count: 0,
    total_responses: 0,
    completed_responses: 0,
    avg_response_time_hours: null,
    last_activity: null,
  };
}

describe('#505 sequential execution — Vercel admin read paths (pool = DB_POOL_MAX = 3)', () => {
  it('getAdminOverview runs its 6-query bundle one query at a time', async () => {
    // 6, not 7: the 5 system-health queries plus the ONE base query
    // getBusinessSummaries issues unpaginated. The tracking sql yields no rows,
    // so that module's conditional metrics CTE is skipped — either way the
    // property under test is the peak, not the count.
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql();

    await getAdminOverview(sql);

    // 1, not 6. A Promise.all here wedges the pool permanently on Vercel.
    expect(getMaxConcurrency()).toBe(1);
  });

  it('fetchBusinessDetailBatch1 runs its 7-query bundle one query at a time', async () => {
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql();

    await fetchBusinessDetailBatch1(sql, 'b1000000-0000-4000-8000-000000000001');

    expect(getMaxConcurrency()).toBe(1);
  });

  it('fetchBusinessDetailBatch2 runs its 6-query bundle one query at a time', async () => {
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql();

    await fetchBusinessDetailBatch2(
      sql,
      'b1000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
    );

    expect(getMaxConcurrency()).toBe(1);
  });

  it('getBusinessSummaries runs its paginated bundle one query at a time', async () => {
    // The queue is SEEDED so the full paginated bundle really runs: one base row
    // → a non-empty `businessIds` → the metrics CTE dispatches. An unseeded
    // harness returns no rows, the CTE is skipped, and this would silently
    // measure the peak over rows → COUNT only, leaving a
    // `Promise.all([count, metrics])` regression green.
    const { sql, getMaxConcurrency, getQueryCount } = makeConcurrencyTrackingSql([
      [seedBusinessRow()], // rows
      [{ total: 1 }], // COUNT
      [], // metrics (no companion row needed — buildBusinessSummary defaults)
    ]);

    await getBusinessSummaries(sql, { limit: 20, offset: 0 });

    // Three, not two: rows → COUNT → metrics. This assertion is what stops the
    // peak below from passing for the wrong reason.
    expect(getQueryCount()).toBe(3);
    expect(getMaxConcurrency()).toBe(1);
  });

  it('the tracking harness actually detects a concurrent bundle (guards the guard)', async () => {
    // Without this, a harness that silently never counted would let every
    // assertion above pass even after a Promise.all was reintroduced.
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql();

    await Promise.all([sql`SELECT 1`, sql`SELECT 2`, sql`SELECT 3`]);

    expect(getMaxConcurrency()).toBe(3);
  });
});
