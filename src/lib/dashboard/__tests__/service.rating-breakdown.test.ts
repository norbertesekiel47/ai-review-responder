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
  withTtlCache: async (_key: string, _ttl: number, compute: () => Promise<unknown>) => compute(),
}));

import { getActiveDashboardData } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;

const BUSINESS_ID = 'biz-rating-1';

// getActiveDashboardData sequential sql call order (no reputation flag):
// 0 business, 1 reviewCounts (all-time total + windowed rating breakdown in
// ONE GROUP BY scan), 2 totalResponded, 3 weeklySeries, 4 ranking,
// 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief, 8 zernioConn,
// 9 queuedReconnect, 10 unresolvedIncident.
const RATING_BREAKDOWN_CALL = 1;

/** A `GROUP BY star_rating` row: `total_count` all-time, `count` windowed. */
type ReviewCountSeed = { stars: number | null; total_count: number; count: number };

function seed(ratingRows: ReviewCountSeed[], totalResponded = 0) {
  harness.resetMockSql();
  harness.sqlReturnQueue.push(
    [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }], // 0 business
    ratingRows, // 1 reviewCounts
    [{ count: totalResponded }], // 2 totalResponded
    [], // 3 weeklySeries
    [], // 4 ranking
    [], // 5 recentReviews
    [], // 6 monthlyBrief
    [], // 7 weeklyBrief
    [], // 8 zernioConn
    [], // 9 queuedReconnect
    [], // 10 unresolvedIncident
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
      { stars: 5, total_count: 3, count: 3 },
      { stars: 4, total_count: 1, count: 1 },
      { stars: 1, total_count: 2, count: 2 },
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

  it('derives the all-time total from EVERY group, the breakdown from the rated groups\' windowed counts', async () => {
    // 5★: 10 all time, 3 in window. 1★: 4 all time, 0 in window (old reviews).
    // NULL stars: 2 unrated reviews — they count toward the total, never the
    // breakdown. Total = 16 regardless of window; breakdown total = 3. The
    // all-time total surfaces only as the response-rate denominator:
    // 4 responded / 16 total = 25%.
    seed(
      [
        { stars: 5, total_count: 10, count: 3 },
        { stars: 1, total_count: 4, count: 0 },
        { stars: null, total_count: 2, count: 0 },
      ],
      4,
    );
    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);
    expect(data.valueSummary.currentResponseRate).toBe(25);
    expect(data.ratingBreakdown.total).toBe(3);
    expect(data.ratingBreakdown.counts).toEqual([
      { stars: 5, count: 3 },
      { stars: 4, count: 0 },
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 0 },
    ]);
  });

  it('scopes the breakdown query by business_id and excludes deleted/unrated rows', async () => {
    seed([{ stars: 5, total_count: 1, count: 1 }]);
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
    seed([{ stars: 5, total_count: 1, count: 1 }]);
    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '30d' });
    const text = ratingBreakdownSql();
    expect(text).toContain('make_interval(days => ?)');
    expect(text).not.toMatch(/INTERVAL\s+'\d+\s+days'/i);
    // windowDays=30 (default) reaches SQL as a bound integer.
    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(30);
  });

  it('honors the selected window (7d / 90d) as the bound interval days', async () => {
    seed([{ stars: 5, total_count: 1, count: 1 }]);
    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '7d' });
    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(7);

    seed([{ stars: 5, total_count: 1, count: 1 }]);
    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '90d' });
    expect(harness.sqlCalls[RATING_BREAKDOWN_CALL]?.values).toContain(90);
  });
});
