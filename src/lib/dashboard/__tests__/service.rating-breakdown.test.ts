import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captures the windowed rating-breakdown query text + bound values so we can
// prove it is tenant-scoped and that the window reaches SQL as a bound
// make_interval param (issue #403), never interpolated text.
const { mockSqlResults, sqlCallCounter, capturedSqlTexts, capturedSqlValues } = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  capturedSqlTexts: [] as string[],
  capturedSqlValues: [] as unknown[][],
}));

vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(() => {}, {
    apply: (_t, _a, args: unknown[]) => {
      const first = args[0];
      if (first != null && typeof first === 'object' && 'raw' in (first as object)) {
        capturedSqlTexts.push((first as TemplateStringsArray).raw.join('?'));
        capturedSqlValues.push(args.slice(1));
      }
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }),
}));

// readPendingMarker reads Redis; tests don't exercise the connect flow.
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: vi.fn(async () => null) }),
}));

import { getActiveDashboardData } from '../service';

const BUSINESS_ID = 'biz-rating-1';

// getActiveDashboardData main Promise.all sql call order (no reputation flag):
// 0 business, 1 totalReviews, 2 totalResponded, 3 velocity, 4 ranking,
// 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief, 8 zernioConn,
// 9 queuedReconnect, 10 unresolvedIncident, 11 ratingBreakdown.
const RATING_BREAKDOWN_CALL = 11;

function seed(ratingRows: Array<{ stars: number; count: number }>) {
  mockSqlResults.length = 0;
  capturedSqlTexts.length = 0;
  capturedSqlValues.length = 0;
  sqlCallCounter.value = 0;
  mockSqlResults[0] = [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }];
  mockSqlResults[1] = [{ count: 0 }];
  mockSqlResults[2] = [{ count: 0 }];
  mockSqlResults[RATING_BREAKDOWN_CALL] = ratingRows;
}

function ratingBreakdownSql(): string {
  return capturedSqlTexts.find((text) => text.includes('GROUP BY star_rating')) ?? '';
}

describe('getActiveDashboardData — ratingBreakdown (#405)', () => {
  beforeEach(() => {
    mockSqlResults.length = 0;
    capturedSqlTexts.length = 0;
    capturedSqlValues.length = 0;
    sqlCallCounter.value = 0;
  });

  it('returns zero-filled 5★→1★ counts and total from the GROUP BY rows', async () => {
    seed([
      { stars: 5, count: 3 },
      { stars: 4, count: 1 },
      { stars: 1, count: 2 },
    ]);
    const data = await getActiveDashboardData(BUSINESS_ID);
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
    const data = await getActiveDashboardData(BUSINESS_ID);
    expect(data.ratingBreakdown.total).toBe(0);
    expect(data.ratingBreakdown.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it('scopes the breakdown query by business_id and excludes deleted/unrated rows', async () => {
    seed([{ stars: 5, count: 1 }]);
    await getActiveDashboardData(BUSINESS_ID);
    const text = ratingBreakdownSql();
    expect(text).toContain('business_id = ?');
    expect(text).toContain("status <> 'deleted'");
    expect(text).toContain('star_rating IS NOT NULL');
    expect(capturedSqlValues[RATING_BREAKDOWN_CALL]).toContain(BUSINESS_ID);
  });

  it('windows the breakdown via a bound make_interval(days => ?) param, not interpolated text', async () => {
    seed([{ stars: 5, count: 1 }]);
    await getActiveDashboardData(BUSINESS_ID, { window: '30d' });
    const text = ratingBreakdownSql();
    expect(text).toContain('make_interval(days => ?)');
    expect(text).not.toMatch(/INTERVAL\s+'\d+\s+days'/i);
    // windowDays=30 (default) reaches SQL as a bound integer.
    expect(capturedSqlValues[RATING_BREAKDOWN_CALL]).toContain(30);
  });

  it('honors the selected window (7d / 90d) as the bound interval days', async () => {
    seed([{ stars: 5, count: 1 }]);
    await getActiveDashboardData(BUSINESS_ID, { window: '7d' });
    expect(capturedSqlValues[RATING_BREAKDOWN_CALL]).toContain(7);

    seed([{ stars: 5, count: 1 }]);
    await getActiveDashboardData(BUSINESS_ID, { window: '90d' });
    expect(capturedSqlValues[RATING_BREAKDOWN_CALL]).toContain(90);
  });
});
