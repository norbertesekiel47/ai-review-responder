// src/lib/locations/__tests__/pool-fanout-sequential.test.ts
//
// #505 regression: the owner's Settings → Locations loader MUST run its
// multi-query wave one query in flight at a time.
//
// WHY: `loadLocationsSettingsView` runs on the singleton `sql` client (passed by
// src/app/(authenticated)/settings/locations/page.tsx — the pool-3 client, NOT
// the larger `sqlRead`), whose pool is `DB_POOL_MAX` = 3 on Vercel. Its wave was
// FOUR members (three `repo` reads + the account tier/status lookup), so fan-out
// exceeded the pool: postgres.js pipelines the excess onto an already-open
// connection over the Supabase Supavisor TRANSACTION pooler, and the pipelined
// response parks server-side in state=active / wait_event=ClientRead forever.
// `statement_timeout` never fires (in ClientRead the statement is not
// executing), so every render leaks a pool slot until the pool starves.
//
// This was the last confirmed instance found by the #769 sweep, and it is the
// page an owner uses to ADD a location — so it gated the multi-location
// aggregate soak (#767) as well as its own surface.
//
// SEAM HONESTY: the pipelining effect is a live-pooler behavior a unit test
// CANNOT reproduce. The max-observed-concurrency === 1 assertion is the closest
// unit-level PROXY for "sequential → nothing pipelines", matching how the #505
// cure is guarded for the admin surface
// (src/lib/admin/__tests__/pool-fanout-sequential.test.ts) and the owner
// dashboard (src/lib/dashboard/__tests__/pool-fanout-sequential.test.ts). Do not
// mistake this green test for full proof of the cure.

import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { loadLocationsSettingsView } from '../settings-view';

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

const ACCOUNT_ID = 'a1000000-0000-4000-8000-000000000001';
const LOCATION_ID = 'b1000000-0000-4000-8000-000000000001';

/**
 * Results in DISPATCH order, which is also source order now that the wave is
 * sequential: locations → active count → archived → account → zernio →
 * pending-approval. Seeding a location makes `allLocationIds` non-empty so the
 * two trailing id-dependent reads actually dispatch (they are skipped for an
 * account with no locations, which would leave them unguarded).
 */
function seededRows() {
  return [
    [{ id: LOCATION_ID, name: 'Loc', display_label: null, is_primary: true, archived_at: null, google_place_id: null, google_place_address: null }],
    [{ count: 1 }],
    [],
    [{ subscription_tier: 'copilot', subscription_status: 'active' }],
    [{ business_id: LOCATION_ID, status: 'active' }],
    [{ business_id: LOCATION_ID, count: 2 }],
  ];
}

describe('#505 sequential execution — owner Settings → Locations (pool = DB_POOL_MAX = 3)', () => {
  it('loadLocationsSettingsView runs its 4-member wave one query at a time', async () => {
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql(seededRows());

    await loadLocationsSettingsView(sql, ACCOUNT_ID);

    // 1, not 4. A Promise.all here wedges the pool permanently on Vercel.
    expect(getMaxConcurrency()).toBe(1);
  });

  it('still maps its rows correctly while sequential (the cure did not empty the page)', async () => {
    // Guards against "fixed" by degrading every read to nothing: sequential
    // must be a scheduling change only, never a data change.
    const { sql } = makeConcurrencyTrackingSql(seededRows());

    const view = await loadLocationsSettingsView(sql, ACCOUNT_ID);

    expect(view.activeCount).toBe(1);
    expect(view.subscriptionTier).toBe('copilot');
    expect(view.locations).toEqual([
      expect.objectContaining({
        id: LOCATION_ID,
        isPrimary: true,
        zernioStatus: 'active',
        pendingApprovalCount: 2,
      }),
    ]);
  });

  it('the tracking harness actually detects a concurrent wave (guards the guard)', async () => {
    // Without this, a harness that silently never counted would let both
    // assertions above pass even after a Promise.all was reintroduced.
    const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql();

    await Promise.all([sql`SELECT 1`, sql`SELECT 2`, sql`SELECT 3`, sql`SELECT 4`]);

    expect(getMaxConcurrency()).toBe(4);
  });
});
