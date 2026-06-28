import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSqlResults, sqlCallCounter, capturedSqlTexts, capturedSqlValues } = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
  capturedSqlTexts: [] as string[],
  // Bound (interpolated) values per query — proves intervals reach SQL as bound
  // params (make_interval(days => $n)), never as interpolated text (#403).
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

import { getAccountKpiSummary, getLocationKpiSummary } from '../service';
import { DEFAULT_DASHBOARD_WINDOW } from '../types';

beforeEach(() => {
  mockSqlResults.length = 0;
  capturedSqlTexts.length = 0;
  capturedSqlValues.length = 0;
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
  // Reset the queue + call index so a re-seed within a single test (two
  // getLocationKpiSummary calls) reads the freshly seeded rows, not stale
  // slots past the first call's cursor.
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
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

describe('getAccountKpiSummary', () => {
  it('returns account scope and computes the same KPIs across active locations', async () => {
    seed({ received: 20, handled: 15, avgStar: 4.2, current: 9, prior: 6, avgHours: 2.0,
      trend: [{ week_start: '2026-04-06', avg_score: 0.25, cnt: 5 }] });
    const summary = await getAccountKpiSummary('acct-1');
    expect(summary.scope).toEqual({ kind: 'account', accountId: 'acct-1' });
    expect(summary.responseRate).toEqual({ handled: 15, received: 20, ratePct: 75 });
    expect(summary.averageStarRating).toBe(4.2);
    expect(summary.sentimentTrend[0]).toEqual({ weekStart: '2026-04-06', averageScore: 0.25, reviewCount: 5 });
  });

  it('scopes every query by account_id and excludes archived locations', async () => {
    seed({});
    await getAccountKpiSummary('acct-XYZ');
    expect(capturedSqlTexts).toHaveLength(5);
    for (const text of capturedSqlTexts) {
      expect(text).toContain('account_id = ?');
      expect(text).toContain('archived_at IS NULL');
    }
  });
});

describe('window parameterization (#403)', () => {
  const flatValues = () => capturedSqlValues.flat();

  it('defaults to the 30-day / 8-week window when no window arg is passed', async () => {
    seed({});
    const summary = await getLocationKpiSummary('biz-1');
    expect(summary.windowDays).toBe(30);
    // Bound integers reach SQL via make_interval(...): windowDays=30 (rate/star/ttr),
    // trendWeeks=8, trendSpanWeeks=7. None of them are interpolated as text.
    expect(flatValues()).toEqual(expect.arrayContaining([30, 8, 7]));
  });

  it('passing the default window explicitly is identical to omitting it', async () => {
    seed({});
    await getLocationKpiSummary('biz-1', DEFAULT_DASHBOARD_WINDOW);
    expect(flatValues()).toEqual(expect.arrayContaining([30, 8, 7]));
  });

  it('threads 7d → windowDays=7, trendWeeks=4 as bound make_interval params', async () => {
    seed({});
    const summary = await getLocationKpiSummary('biz-1', '7d');
    expect(summary.windowDays).toBe(7);
    expect(flatValues()).toEqual(expect.arrayContaining([7, 4, 3]));
  });

  it('threads 90d → windowDays=90, trendWeeks=13', async () => {
    seed({});
    const summary = await getLocationKpiSummary('biz-1', '90d');
    expect(summary.windowDays).toBe(90);
    expect(flatValues()).toEqual(expect.arrayContaining([90, 13]));
  });

  it('threads 12w → windowDays=84, trendWeeks=12 for the account scope too', async () => {
    seed({});
    const summary = await getAccountKpiSummary('acct-1', '12w');
    expect(summary.windowDays).toBe(84);
    expect(flatValues()).toEqual(expect.arrayContaining([84, 12]));
  });

  it('never interpolates an interval as raw SQL text — every window uses make_interval', async () => {
    seed({});
    await getLocationKpiSummary('biz-1', '7d');
    for (const text of capturedSqlTexts) {
      expect(text).not.toMatch(/INTERVAL\s+'\d+\s+(days|weeks)'/i);
    }
    const joined = capturedSqlTexts.join('\n');
    expect(joined).toContain('make_interval(days => ?)');
    expect(joined).toContain('make_interval(weeks => ?)');
  });
});
