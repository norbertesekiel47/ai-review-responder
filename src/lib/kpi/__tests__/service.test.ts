import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { getLocationKpiSummary } from '../service';

beforeEach(() => {
  mockSqlResults.length = 0;
  capturedSqlTexts.length = 0;
  sqlCallCounter.value = 0;
});
/**
 * getLocationKpiSummary issues its queries via Promise.all in this fixed order:
 * 0: responseRate {received, handled}
 * 1: averageStarRating {avg}
 * 2: reviewVolume {current_month, prior_month}
 * 3: averageTimeToRespondHours {avg_hours}
 * 4: sentimentTrend rows [{week_start, avg_score, cnt}, ...]
 */
function seed(opts: {
  received?: number; handled?: number; avgStar?: number | null;
  current?: number; prior?: number; avgHours?: number | null;
  trend?: Array<{ week_start: string; avg_score: number | null; cnt: number }>;
}) {
  mockSqlResults[0] = [{ received: opts.received ?? 0, handled: opts.handled ?? 0 }];
  mockSqlResults[1] = [{ avg: opts.avgStar ?? null }];
  mockSqlResults[2] = [{ current_month: opts.current ?? 0, prior_month: opts.prior ?? 0 }];
  mockSqlResults[3] = [{ avg_hours: opts.avgHours ?? null }];
  mockSqlResults[4] = opts.trend ?? [];
}

describe('getLocationKpiSummary', () => {
  it('computes response rate and returns location scope', async () => {
    seed({ received: 10, handled: 8 });
    const summary = await getLocationKpiSummary('biz-1');
    expect(summary.scope).toEqual({ kind: 'location', businessId: 'biz-1' });
    expect(summary.windowDays).toBe(30);
    expect(summary.responseRate).toEqual({ handled: 8, received: 10, ratePct: 80 });
  });

  it('returns null ratePct when no reviews received', async () => {
    seed({ received: 0, handled: 0 });
    const summary = await getLocationKpiSummary('biz-1');
    expect(summary.responseRate.ratePct).toBeNull();
  });

  it('rounds average star rating to 2 decimals and passes through null', async () => {
    seed({ avgStar: 4.333333 });
    expect((await getLocationKpiSummary('biz-1')).averageStarRating).toBe(4.33);
    seed({ avgStar: null });
    expect((await getLocationKpiSummary('biz-1')).averageStarRating).toBeNull();
  });

  it('computes review volume MoM delta, null when prior month is 0', async () => {
    seed({ current: 12, prior: 8 });
    expect((await getLocationKpiSummary('biz-1')).reviewVolume).toEqual({
      currentMonth: 12, priorMonth: 8, deltaPct: 50,
    });
    seed({ current: 5, prior: 0 });
    expect((await getLocationKpiSummary('biz-1')).reviewVolume.deltaPct).toBeNull();
  });

  it('rounds average time-to-respond to 1 decimal; null when none', async () => {
    seed({ avgHours: 3.45 });
    expect((await getLocationKpiSummary('biz-1')).averageTimeToRespondHours).toBe(3.5);
    seed({ avgHours: null });
    expect((await getLocationKpiSummary('biz-1')).averageTimeToRespondHours).toBeNull();
  });

  it('maps the sentiment trend series (null avg preserved, score rounded)', async () => {
    seed({ trend: [
      { week_start: '2026-04-06', avg_score: 0.5, cnt: 4 },
      { week_start: '2026-04-13', avg_score: null, cnt: 0 },
      { week_start: '2026-04-20', avg_score: 0.333333, cnt: 3 },
    ]});
    const trend = (await getLocationKpiSummary('biz-1')).sentimentTrend;
    expect(trend).toEqual([
      { weekStart: '2026-04-06', averageScore: 0.5, reviewCount: 4 },
      { weekStart: '2026-04-13', averageScore: null, reviewCount: 0 },
      { weekStart: '2026-04-20', averageScore: 0.33, reviewCount: 3 },
    ]);
  });

  it('scopes every query by business_id', async () => {
    seed({});
    await getLocationKpiSummary('biz-XYZ');
    expect(capturedSqlTexts).toHaveLength(5);
    for (const text of capturedSqlTexts) {
      expect(text).toContain('business_id = ?');
    }
  });
});
