// src/lib/dashboard/__tests__/pool-fanout-sequential.test.ts
//
// #505 regression: the OWNER dashboard read paths MUST run their multi-query
// waves one query in flight at a time.
//
// WHY: these run on the singleton `sql` client (passed by
// src/app/api/dashboard/route.ts — the pool-3 client, NOT the larger `sqlRead`),
// whose pool is `DB_POOL_MAX` = 3 on Vercel. Firing more concurrent queries than
// the pool has connections makes postgres.js pipeline the excess onto
// already-open connections over the Supabase Supavisor TRANSACTION pooler; a
// pipelined query's response then parks server-side in state=active /
// wait_event=ClientRead and is never read — a PERMANENT Connection wedge that no
// server-side timeout heals, leaking a pool slot per render until the pool
// starves. The same defect took the admin portal down on staging 2026-08-10;
// these were the owner-facing instances of it (13-member main wave, 8-member
// aggregate wave, 5-query reputation batch).
//
// SEAM HONESTY: the pipelining effect is a live-pooler behavior a unit test
// CANNOT reproduce. The max-observed-concurrency === 1 assertion is the closest
// unit-level PROXY for "sequential → nothing pipelines", matching how the #505
// cure is guarded for runHealthChecks and for the admin surface
// (src/lib/admin/__tests__/pool-fanout-sequential.test.ts). Do not mistake this
// green test for full proof of the cure.

import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';

// readPendingMarker (inside the main wave) reads the cache; the payload cache
// must MISS so the compute actually runs.
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
  }),
  withTtlCache: async (_key: string, _ttl: number, compute: () => Promise<unknown>) => compute(),
}));

import { getActiveDashboardData } from '../service';
import { fetchPerLocationAggregateSlices } from '../aggregate-queries';

/**
 * Fake `sql` recording the peak number of simultaneously in-flight queries.
 *
 * Queries are LAZY THENABLES: a tagged template only counts as in flight once
 * something calls `.then` on it, and resolves after a macrotask so overlap is
 * observable. That laziness is what makes this fragment-safe — nested `sql`
 * fragments are built as interpolated values and never awaited, so they never
 * inflate the count.
 *
 * Sequential execution keeps the peak at 1. A concurrent driver over N members
 * calls all N `.then`s in the same tick before any resolves → peak N.
 */
function makeConcurrencyTrackingSql(rows: unknown[] = []) {
  let inFlight = 0;
  let maxInFlight = 0;
  const queue = [...rows];

  const sql = ((..._args: unknown[]) => ({
    then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((settle) => setTimeout(settle, 0))
        .then(() => {
          inFlight -= 1;
          const next = queue.shift() ?? [];
          return Array.isArray(next) ? next : [next];
        })
        .then(resolve, reject);
    },
  })) as unknown as Sql;

  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
  (sql as unknown as { begin: (cb: (tx: unknown) => unknown) => Promise<unknown> }).begin = (cb) =>
    Promise.resolve(cb(sql));

  return { sql, getMaxConcurrency: () => maxInFlight };
}

describe('#505 sequential execution — owner dashboard (pool = DB_POOL_MAX = 3)', () => {
  it('getActiveDashboardData runs its 13-member wave one query at a time', async () => {
    // First result feeds the FATAL business read; the rest degrade to empty.
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql([
      [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }],
    ]);

    // includeReputationMetrics exercises the reputation batch INSIDE the wave —
    // the widest path, and the one that nests a 5-query bundle in a wave member.
    await getActiveDashboardData(sql, 'biz-fanout-1', { includeReputationMetrics: true });

    // 1, not 13. A concurrent driver here wedges the pool permanently on Vercel.
    expect(getMaxConcurrency()).toBe(1);
  });

  it('fetchPerLocationAggregateSlices runs its 8-member wave one query at a time', async () => {
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql();

    await fetchPerLocationAggregateSlices(sql, 'acct-fanout-1', '30d');

    expect(getMaxConcurrency()).toBe(1);
  });

  it('the tracking harness actually detects a concurrent wave (guards the guard)', async () => {
    // Without this, a harness that silently never counted would let both
    // assertions above pass even after a concurrent driver was reintroduced.
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql();

    await Promise.all([sql`SELECT 1`, sql`SELECT 2`, sql`SELECT 3`]);

    expect(getMaxConcurrency()).toBe(3);
  });
});
