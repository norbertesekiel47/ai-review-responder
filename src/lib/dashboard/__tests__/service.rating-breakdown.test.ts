import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
import { REVIEW_STATUS } from '@/lib/reviews/status';

// dashboard/service is born-injected (sql is a parameter, A+ campaign PR 2d), so
// @/lib/db/server no longer needs mocking here — the fragment-aware
// createMockSql harness stands in for `sql` directly (worker/__tests__/helpers/mock-sql.ts).

// readPendingMarker + the payload read cache both hit Redis; always-miss stub.
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));

import { getActiveDashboardData } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;

const BUSINESS_ID = 'biz-rating-1';

// getActiveDashboardData main Promise.all sql call order (no reputation flag):
// 0 business, 1 totalReviews, 2 totalResponded, 3 velocity, 4 ranking,
// 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief, 8 zernioConn,
// 9 queuedReconnect, 10 unresolvedIncident, 11 ratingBreakdown.
const RATING_BREAKDOWN_CALL = 11;

function seed(ratingRows: Array<{ stars: number; count: number }>) {
  harness.resetMockSql();
  harness.sqlReturnQueue.push(
    [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }], // 0 business
    [{ count: 0 }], // 1 totalReviews
    [{ count: 0 }], // 2 totalResponded
    [], // 3 velocity
    [], // 4 ranking
    [], // 5 recentReviews
    [], // 6 monthlyBrief
    [], // 7 weeklyBrief
    [], // 8 zernioConn
    [], // 9 queuedReconnect
    [], // 10 unresolvedIncident
    ratingRows, // 11 ratingBreakdown
  );
}

function ratingBreakdownSql(): string {
  return harness.sqlCalls.find((call) => call.text.includes('GROUP BY star_rating'))?.text ?? '';
}

describe('getActiveDashboardData — ratingBreakdown (#405)', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
  });

  it('returns zero-filled 5★→1★ counts and total from the GROUP BY rows', async () => {
    seed([
      { stars: 5, count: 3 },
      { stars: 4, count: 1 },
      { stars: 1, count: 2 },
    ]);
    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);
    expect(data.ratingBreakdown.counts).toEqual([
      { stars: 5, count: 3 },
      { stars: 4, count: 0 + 1 },
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 2 },
    ]);
    expect(data.ratingBreakdown.total).toBe(6);
  });

  it('returns an all-zero breakdown (total 0) when the window holds no rated review', async () => {
    seed([]);
    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);
    expect(data.ratingBreakdown.total).toBe(0);
    expect(data.ratingBreakdown.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it('scopes the breakdown query by business_id and excludes deleted/unrated rows', async () => {
    seed([{ stars: 5, count: 1 }]);
    await getActiveDashboardData(mockSql, BUSINESS_ID);
    const text = ratingBreakdownSql();
    expect(text).toContain('business_id = ?');
    // REVIEW_STATUS.DELETED is now a bound param, not an inline literal (A+ campaign 2d).
    expect(text).toContain('status <> ?');
    expect(text).toContain('star_rating IS NOT NULL');
    const call = harness.sqlCalls[RATING_BREAKDOWN_CALL];
    expect(call?.values).toContain(BUSINESS_ID);
    expect(call?.values).toContain(REVIEW_STATUS.DELETED);
  });

  it('windows the breakdown via a bound make_interval(days => ?) param, not interpolated text', async () => {
    seed([{ stars: 5, count: 1 }]);
    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '30d' });
    const text = ratingBreakdownSql();
    expect(text).toContain('make_interval(days => ?)');
    expect(text).not.toMatch(/INTERVAL\s+'\d+\s+days'/i);
    // windowDays=30 (default) reaches SQL as a bound integer.
    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(30);
  });

  it('honors the selected window (7d / 90d) as the bound interval days', async () => {
    seed([{ stars: 5, count: 1 }]);
    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '7d' });
    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(7);

    seed([{ stars: 5, count: 1 }]);
    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '90d' });
    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(90);
  });
});
