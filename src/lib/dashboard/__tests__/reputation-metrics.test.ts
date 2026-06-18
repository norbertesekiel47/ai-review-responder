import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors the kpi/service.test.ts sql-proxy mock: capture template texts and
// return seeded rows in call order. getReputationMetrics issues exactly four
// queries via Promise.all: 0 = reviews buckets, 1 = time-saved buckets,
// 2 = 8-week sentiment trend, 3 = pending-count (inside getPendingApprovalCount).
const { mockSqlResults, sqlCallCounter, capturedSqlTexts } = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  capturedSqlTexts: [] as string[],
}));

vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(() => {}, {
    apply: (_t, _a, args: unknown[]) => {
      const first = args[0];
      if (first != null && typeof first === 'object' && 'raw' in (first as object)) {
        capturedSqlTexts.push((first as TemplateStringsArray).raw.join('?'));
      }
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }),
}));

import { getReputationMetrics, RAMPING_AGE_DAYS } from '../reputation-metrics';

beforeEach(() => {
  mockSqlResults.length = 0;
  capturedSqlTexts.length = 0;
  sqlCallCounter.value = 0;
});

function seed(opts: {
  reviews?: Record<string, unknown>;
  time?: Record<string, unknown>;
  trend?: Array<{ week_start: string; avg_score: number | null; cnt: number }>;
  pending?: number;
}) {
  mockSqlResults[0] = [{
    cur_received: 0, cur_handled: 0, cur_avg_star: null,
    prior_received: 0, prior_handled: 0, prior_avg_star: null, prior_star_count: 0,
    ...opts.reviews,
  }];
  mockSqlResults[1] = [{ cur_handled_count: 0, prior_handled_count: 0, ...opts.time }];
  mockSqlResults[2] = opts.trend ?? [];
  mockSqlResults[3] = [{ count: opts.pending ?? 0 }];
}

const MATURE = new Date(Date.now() - 90 * 86_400_000);
const YOUNG = new Date(Date.now() - 5 * 86_400_000);

describe('getReputationMetrics — typed, unit-correct deltas', () => {
  it('response rate value + delta in PERCENTAGE POINTS with prior sample', async () => {
    seed({ reviews: { cur_received: 10, cur_handled: 8, prior_received: 5, prior_handled: 2 } });
    const s = await getReputationMetrics('biz-1', MATURE);
    expect(s.responseRate.value).toBe(80); // 8/10
    expect(s.responseRate.delta).toBe(40); // 80% - 40% = 40 pts (not a relative %)
    expect(s.responseRate.priorSample).toBe(5);
  });

  it('avg star value + delta in RATING POINTS', async () => {
    seed({ reviews: { cur_avg_star: 4.5, prior_avg_star: 4.0, prior_star_count: 4 } });
    const s = await getReputationMetrics('biz-1', MATURE);
    expect(s.averageStarRating.value).toBe(4.5);
    expect(s.averageStarRating.delta).toBe(0.5);
    expect(s.averageStarRating.priorSample).toBe(4);
  });

  it('time saved value + delta in MINUTES (count × 7)', async () => {
    seed({ time: { cur_handled_count: 10, prior_handled_count: 4 } });
    const s = await getReputationMetrics('biz-1', MATURE);
    expect(s.timeSavedMinutes.value).toBe(70); // 10 × 7
    expect(s.timeSavedMinutes.delta).toBe(42); // (10-4) × 7
    expect(s.timeSavedMinutes.priorSample).toBe(4);
  });

  it('suppresses an individual delta when that metric prior sample is zero', async () => {
    // Mature business, but no reviews in the prior window for response rate
    // and no prior handled responses for time saved.
    seed({
      reviews: { cur_received: 6, cur_handled: 6, prior_received: 0, cur_avg_star: 5, prior_star_count: 0 },
      time: { cur_handled_count: 6, prior_handled_count: 0 },
    });
    const s = await getReputationMetrics('biz-1', MATURE);
    expect(s.responseRate.value).toBe(100);
    expect(s.responseRate.delta).toBeNull();
    expect(s.averageStarRating.value).toBe(5);
    expect(s.averageStarRating.delta).toBeNull();
    expect(s.timeSavedMinutes.value).toBe(42);
    expect(s.timeSavedMinutes.delta).toBeNull();
  });

  it('null current value yields null value and null delta (no rated reviews)', async () => {
    seed({ reviews: { cur_received: 0, prior_received: 0, cur_avg_star: null } });
    const s = await getReputationMetrics('biz-1', MATURE);
    expect(s.responseRate.value).toBeNull();
    expect(s.averageStarRating.value).toBeNull();
    expect(s.averageStarRating.delta).toBeNull();
  });

  it('ramping reflects location age vs RAMPING_AGE_DAYS', async () => {
    seed({});
    expect((await getReputationMetrics('biz-1', YOUNG)).ramping).toBe(true);
    seed({});
    expect((await getReputationMetrics('biz-1', MATURE)).ramping).toBe(false);
    // Boundary: just inside the threshold is still ramping.
    seed({});
    const justInside = new Date(Date.now() - (RAMPING_AGE_DAYS - 1) * 86_400_000);
    expect((await getReputationMetrics('biz-1', justInside)).ramping).toBe(true);
  });

  it('passes through the shared pending-approval count', async () => {
    seed({ pending: 3 });
    expect((await getReputationMetrics('biz-1', MATURE)).pendingApprovalCount).toBe(3);
  });

  it('maps the 8-week sentiment trend (null avg preserved, score rounded)', async () => {
    seed({ trend: [
      { week_start: '2026-05-04', avg_score: 0.5, cnt: 4 },
      { week_start: '2026-05-11', avg_score: null, cnt: 0 },
      { week_start: '2026-05-18', avg_score: 0.333333, cnt: 3 },
    ] });
    const trend = (await getReputationMetrics('biz-1', MATURE)).sentimentTrend;
    expect(trend).toEqual([
      { weekStart: '2026-05-04', averageScore: 0.5, reviewCount: 4 },
      { weekStart: '2026-05-11', averageScore: null, reviewCount: 0 },
      { weekStart: '2026-05-18', averageScore: 0.33, reviewCount: 3 },
    ]);
  });

  it('scopes every query by business_id and excludes deleted reviews', async () => {
    seed({});
    await getReputationMetrics('biz-XYZ', MATURE);
    expect(capturedSqlTexts).toHaveLength(4);
    for (const text of capturedSqlTexts) {
      expect(text).toContain('business_id = ?');
    }
    // reviews-keyed queries exclude deleted; pending-count query excludes open-flagged.
    expect(capturedSqlTexts[0]).toContain("status <> 'deleted'");
    expect(capturedSqlTexts[3]).toContain('flagged_responses');
  });
});
