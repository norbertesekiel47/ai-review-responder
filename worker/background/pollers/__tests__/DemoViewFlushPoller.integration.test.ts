// Live-Postgres suite for DemoViewFlushPoller's batched UPDATE (#1369).
//
// The unit suite (DemoViewFlushPoller.test.ts) pins the query's shape against
// a mock `sql`; only a real schema proves the `unnest(...::uuid[], ...::int[],
// ...::timestamptz[])` array binding and the additive `view_count = view_count
// + delta_count` actually type-check and apply correctly against
// `prospect_demos`. Only `drainPendingDemoViews` (the Redis-facing half) is
// mocked here — Postgres is real.
//
// Applies NO migration SQL: `pnpm test:db:setup` provisions the schema and
// this file relies on `prospect_demos` already existing (migration 001). No
// cross-process live-DB lock: every row this test touches is scoped to a
// unique slug prefix generated for this run, so it cannot race a concurrent
// suite's fixtures the way a GLOBAL retention sweep (ArchivalPoller) could —
// same reasoning as src/lib/demos/__tests__/lifecycle.integration.test.ts.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from '@/lib/db/server';
import { createWorkerLogger } from '@/lib/shared/logger';

const testDb = process.env.TEST_DATABASE_POOL_URL;

const mockDrainPendingDemoViews = vi.fn();
vi.mock('@/lib/demos/view-tracking', () => ({
  drainPendingDemoViews: mockDrainPendingDemoViews,
}));

describe('DemoViewFlushPoller (live DB)', () => {
  if (!testDb) {
    it.skip('skipping — TEST_DATABASE_POOL_URL not set', () => {});
    return;
  }

  const SLUG_PREFIX = `t-${Date.now().toString(36).slice(-6)}-`;

  async function insertProspectDemo(viewCount: number): Promise<string> {
    const id = randomUUID();
    const slug = `${SLUG_PREFIX}${Math.random().toString(36).slice(2, 8)}`;
    await sql`
      INSERT INTO prospect_demos (id, business_name, demo_url_slug, generation_status, view_count)
      VALUES (${id}, 'Test Biz', ${slug}, 'completed', ${viewCount})
    `;
    return id;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await sql`DELETE FROM prospect_demos WHERE demo_url_slug LIKE ${SLUG_PREFIX + '%'}`;
  });

  afterEach(async () => {
    await sql`DELETE FROM prospect_demos WHERE demo_url_slug LIKE ${SLUG_PREFIX + '%'}`;
  });

  it('applies a batch of deltas as one additive UPDATE, and a delta for a since-deleted row is a harmless no-op', async () => {
    const id1 = await insertProspectDemo(5);
    const id2 = await insertProspectDemo(0);
    const goneId = randomUUID(); // never inserted — simulates a row deleted between GETDEL and this write
    const lastViewed1 = new Date();
    const lastViewed2 = new Date(Date.now() - 60_000);

    mockDrainPendingDemoViews.mockResolvedValueOnce([
      { demoId: id1, count: 3, lastViewedAt: lastViewed1 },
      { demoId: id2, count: 1, lastViewedAt: lastViewed2 },
      { demoId: goneId, count: 7, lastViewedAt: new Date() },
    ]);

    const { runDemoViewFlush } = await import('../DemoViewFlushPoller');
    await runDemoViewFlush(createWorkerLogger('[DemoViewFlushPollerIntegration]'));

    const rows = await sql<{ id: string; view_count: number; last_viewed_at: Date | null }[]>`
      SELECT id, view_count, last_viewed_at FROM prospect_demos WHERE id = ANY(${[id1, id2]}::uuid[])
    `;
    const row1 = rows.find((r) => r.id === id1);
    const row2 = rows.find((r) => r.id === id2);

    // Additive, not overwritten: 5 + 3, 0 + 1.
    expect(row1?.view_count).toBe(8);
    expect(row2?.view_count).toBe(1);
    expect(row1?.last_viewed_at?.getTime()).toBe(lastViewed1.getTime());
    expect(row2?.last_viewed_at?.getTime()).toBe(lastViewed2.getTime());

    // The since-deleted id's delta matched zero rows — no error, no orphan
    // insert, and it did not block the other two demos' updates above.
    const goneRow = await sql<{ id: string }[]>`
      SELECT id FROM prospect_demos WHERE id = ${goneId}
    `;
    expect(goneRow).toHaveLength(0);
  });

  it('is a no-op against Postgres when nothing was pending in Redis', async () => {
    const id = await insertProspectDemo(2);
    mockDrainPendingDemoViews.mockResolvedValueOnce([]);

    const { runDemoViewFlush } = await import('../DemoViewFlushPoller');
    await runDemoViewFlush(createWorkerLogger('[DemoViewFlushPollerIntegration]'));

    const [row] = await sql<{ view_count: number }[]>`
      SELECT view_count FROM prospect_demos WHERE id = ${id}
    `;
    expect(row?.view_count).toBe(2);
  });
});
