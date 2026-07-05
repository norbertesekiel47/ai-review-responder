// kpi/service is born-injected (sql is a parameter, A+ campaign PR 2d), so
// @/lib/db/server no longer needs mocking here — the fragment-aware
// createMockSql harness stands in for `sql` directly (worker/__tests__/helpers/mock-sql.ts).

import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
import { getAccountKpiSummary, getLocationKpiSummary } from '../service';
import { DEFAULT_DASHBOARD_WINDOW } from '../types';

let harness: MockSqlHarness;
let mockSql: Sql;

/**
 * getLocationKpiSummary/getAccountKpiSummary issue their queries via
 * Promise.all in this fixed order:
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
} = {}) {
  harness.sqlReturnQueue.push([{ received: opts.received ?? 0, handled: opts.handled ?? 0 }]);
  harness.sqlReturnQueue.push([{ avg: opts.avgStar ?? null }]);
  harness.sqlReturnQueue.push([{ current_month: opts.current ?? 0, prior_month: opts.prior ?? 0 }]);
  harness.sqlReturnQueue.push([{ avg_hours: opts.avgHours ?? null }]);
  harness.sqlReturnQueue.push(opts.trend ?? []);
}

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

describe('getLocationKpiSummary', () => {
  it('computes response rate and returns location scope', async () => {
    seed({ received: 10, handled: 8 });
    const summary = await getLocationKpiSummary(mockSql, 'biz-1');
    expect(summary.scope).toEqual({ kind: 'location', businessId: 'biz-1' });
    expect(summary.windowDays).toBe(30);
    expect(summary.responseRate).toEqual({ handled: 8, received: 10, ratePct: 80 });
  });

  it('returns null ratePct when no reviews received', async () => {
    seed({ received: 0, handled: 0 });
    const summary = await getLocationKpiSummary(mockSql, 'biz-1');
    expect(summary.responseRate.ratePct).toBeNull();
  });

  it('rounds average star rating to 2 decimals and passes through null', async () => {
    seed({ avgStar: 4.333333 });
    expect((await getLocationKpiSummary(mockSql, 'biz-1')).averageStarRating).toBe(4.33);
    seed({ avgStar: null });
    expect((await getLocationKpiSummary(mockSql, 'biz-1')).averageStarRating).toBeNull();
  });

  it('computes review volume MoM delta, null when prior month is 0', async () => {
    seed({ current: 12, prior: 8 });
    expect((await getLocationKpiSummary(mockSql, 'biz-1')).reviewVolume).toEqual({
      currentMonth: 12, priorMonth: 8, deltaPct: 50,
    });
    seed({ current: 5, prior: 0 });
    expect((await getLocationKpiSummary(mockSql, 'biz-1')).reviewVolume.deltaPct).toBeNull();
  });

  it('rounds average time-to-respond to 1 decimal; null when none', async () => {
    seed({ avgHours: 3.45 });
    expect((await getLocationKpiSummary(mockSql, 'biz-1')).averageTimeToRespondHours).toBe(3.5);
    seed({ avgHours: null });
    expect((await getLocationKpiSummary(mockSql, 'biz-1')).averageTimeToRespondHours).toBeNull();
  });

  it('maps the sentiment trend series (null avg preserved, score rounded)', async () => {
    seed({ trend: [
      { week_start: '2026-04-06', avg_score: 0.5, cnt: 4 },
      { week_start: '2026-04-13', avg_score: null, cnt: 0 },
      { week_start: '2026-04-20', avg_score: 0.333333, cnt: 3 },
    ]});
    const trend = (await getLocationKpiSummary(mockSql, 'biz-1')).sentimentTrend;
    expect(trend).toEqual([
      { weekStart: '2026-04-06', averageScore: 0.5, reviewCount: 4 },
      { weekStart: '2026-04-13', averageScore: null, reviewCount: 0 },
      { weekStart: '2026-04-20', averageScore: 0.33, reviewCount: 3 },
    ]);
  });

  it('scopes every query by business_id', async () => {
    seed();
    await getLocationKpiSummary(mockSql, 'biz-XYZ');
    expect(harness.sqlCalls).toHaveLength(5);
    for (const call of harness.sqlCalls) {
      expect(call.text).toContain('business_id = ?');
    }
  });
});

describe('getAccountKpiSummary', () => {
  it('returns account scope and computes the same KPIs across active locations', async () => {
    seed({ received: 20, handled: 15, avgStar: 4.2, current: 9, prior: 6, avgHours: 2.0,
      trend: [{ week_start: '2026-04-06', avg_score: 0.25, cnt: 5 }] });
    const summary = await getAccountKpiSummary(mockSql, 'acct-1');
    expect(summary.scope).toEqual({ kind: 'account', accountId: 'acct-1' });
    expect(summary.responseRate).toEqual({ handled: 15, received: 20, ratePct: 75 });
    expect(summary.averageStarRating).toBe(4.2);
    expect(summary.sentimentTrend[0]).toEqual({ weekStart: '2026-04-06', averageScore: 0.25, reviewCount: 5 });
  });

  it('scopes every query by account_id and excludes archived locations', async () => {
    seed();
    await getAccountKpiSummary(mockSql, 'acct-XYZ');
    expect(harness.sqlCalls).toHaveLength(5);
    for (const call of harness.sqlCalls) {
      expect(call.text).toContain('account_id = ?');
      expect(call.text).toContain('archived_at IS NULL');
    }
  });
});

describe('window parameterization (#403)', () => {
  const flatValues = () => harness.sqlCalls.flatMap((call) => call.values);

  it('defaults to the 30-day / 8-week window when no window arg is passed', async () => {
    seed();
    const summary = await getLocationKpiSummary(mockSql, 'biz-1');
    expect(summary.windowDays).toBe(30);
    // Bound integers reach SQL via make_interval(...): windowDays=30 (rate/star/ttr),
    // trendWeeks=8, trendSpanWeeks=7. None of them are interpolated as text.
    expect(flatValues()).toEqual(expect.arrayContaining([30, 8, 7]));
  });

  it('passing the default window explicitly is identical to omitting it', async () => {
    seed();
    await getLocationKpiSummary(mockSql, 'biz-1', DEFAULT_DASHBOARD_WINDOW);
    expect(flatValues()).toEqual(expect.arrayContaining([30, 8, 7]));
  });

  it('threads 7d → windowDays=7, trendWeeks=4 as bound make_interval params', async () => {
    seed();
    const summary = await getLocationKpiSummary(mockSql, 'biz-1', '7d');
    expect(summary.windowDays).toBe(7);
    expect(flatValues()).toEqual(expect.arrayContaining([7, 4, 3]));
  });

  it('threads 90d → windowDays=90, trendWeeks=13', async () => {
    seed();
    const summary = await getLocationKpiSummary(mockSql, 'biz-1', '90d');
    expect(summary.windowDays).toBe(90);
    expect(flatValues()).toEqual(expect.arrayContaining([90, 13]));
  });

  it('threads 12w → windowDays=84, trendWeeks=12 for the account scope too', async () => {
    seed();
    const summary = await getAccountKpiSummary(mockSql, 'acct-1', '12w');
    expect(summary.windowDays).toBe(84);
    expect(flatValues()).toEqual(expect.arrayContaining([84, 12]));
  });

  it('never interpolates an interval as raw SQL text — every window uses make_interval', async () => {
    seed();
    await getLocationKpiSummary(mockSql, 'biz-1', '7d');
    for (const call of harness.sqlCalls) {
      expect(call.text).not.toMatch(/INTERVAL\s+'\d+\s+(days|weeks)'/i);
    }
    const joined = harness.sqlCalls.map((call) => call.text).join('\n');
    expect(joined).toContain('make_interval(days => ?)');
    expect(joined).toContain('make_interval(weeks => ?)');
  });
});

// ---------------------------------------------------------------------------
// Characterization pins (A+ campaign 2d).
//
// These lock the exact composed SQL text each function emits, captured
// against the PRE-refactor code (module-level `sql` import, no fragments,
// literal 'deleted') via a throwaway Proxy-mock capture, then transcribed
// here with the one intentional text change: the raw 'deleted' string
// literal becomes a bound REVIEW_STATUS.DELETED parameter (rendered as `?`,
// same as every other bound value) — the task's REVIEW_STATUS adoption.
// Every other character, including whitespace, is unchanged: the shared
// fragments (notDeletedFilter, detectedAtWindowFilter, handledStatusFilter,
// ttrSelectExpr, ttrHandledWindowFilter) compose byte-identically into each
// caller's own template. If these ever need to change, re-derive them from
// scratch against the real behavior — do not just relax the assertion.
// ---------------------------------------------------------------------------

describe('characterization: composed SQL is byte-identical (modulo REVIEW_STATUS)', () => {
  const RATE_LOCATION = `
      SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM responses resp
            WHERE resp.review_id = r.id
              AND resp.status = ANY(?::text[])
          )
        )::int AS handled
      FROM reviews r
      WHERE r.business_id = ?
        AND r.status <> ?
        AND r.detected_at >= NOW() - make_interval(days => ?)
    `;
  const STAR_LOCATION = `
      SELECT AVG(star_rating)::float AS avg
      FROM reviews
      WHERE business_id = ?
        AND status <> ?
        AND star_rating IS NOT NULL
        AND detected_at >= NOW() - make_interval(days => ?)
    `;
  const VOLUME_LOCATION = `
      SELECT
        COUNT(*) FILTER (
          WHERE detected_at >= DATE_TRUNC('month', NOW())
        )::int AS current_month,
        COUNT(*) FILTER (
          WHERE detected_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
            AND detected_at < DATE_TRUNC('month', NOW())
        )::int AS prior_month
      FROM reviews
      WHERE business_id = ?
        AND status <> ?
    `;
  const TTR_LOCATION = `
      SELECT AVG(EXTRACT(EPOCH FROM (resp.approved_at - r.detected_at)) / 3600.0)::float AS avg_hours
      FROM responses resp
      JOIN reviews r ON r.id = resp.review_id
      WHERE r.business_id = ?
        AND r.status <> ?
        AND resp.status = ANY(?::text[])
        AND resp.approved_at IS NOT NULL
        AND resp.approved_at >= NOW() - make_interval(days => ?)
    `;
  const TREND_LOCATION = `
      SELECT gs::date AS week_start,
             agg.avg_score::float AS avg_score,
             COALESCE(agg.cnt, 0)::int AS cnt
      FROM generate_series(
        DATE_TRUNC('week', NOW() - make_interval(weeks => ?)),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN (
        SELECT DATE_TRUNC('week', detected_at)::date AS wk,
               AVG(sentiment_score) AS avg_score,
               COUNT(*) AS cnt
        FROM reviews
        WHERE business_id = ?
          AND status <> ?
          AND detected_at >= NOW() - make_interval(weeks => ?)
        GROUP BY DATE_TRUNC('week', detected_at)
      ) agg ON agg.wk = gs::date
      ORDER BY week_start ASC
    `;

  const RATE_ACCOUNT = `
      SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM responses resp
            WHERE resp.review_id = r.id
              AND resp.status = ANY(?::text[])
          )
        )::int AS handled
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ?
        AND b.archived_at IS NULL
        AND r.status <> ?
        AND r.detected_at >= NOW() - make_interval(days => ?)
    `;
  const STAR_ACCOUNT = `
      SELECT AVG(r.star_rating)::float AS avg
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ?
        AND b.archived_at IS NULL
        AND r.status <> ?
        AND r.star_rating IS NOT NULL
        AND r.detected_at >= NOW() - make_interval(days => ?)
    `;
  const VOLUME_ACCOUNT = `
      SELECT
        COUNT(*) FILTER (WHERE r.detected_at >= DATE_TRUNC('month', NOW()))::int AS current_month,
        COUNT(*) FILTER (
          WHERE r.detected_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
            AND r.detected_at < DATE_TRUNC('month', NOW())
        )::int AS prior_month
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ?
        AND b.archived_at IS NULL
        AND r.status <> ?
    `;
  const TTR_ACCOUNT = `
      SELECT AVG(EXTRACT(EPOCH FROM (resp.approved_at - r.detected_at)) / 3600.0)::float AS avg_hours
      FROM responses resp
      JOIN reviews r ON r.id = resp.review_id
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ?
        AND b.archived_at IS NULL
        AND r.status <> ?
        AND resp.status = ANY(?::text[])
        AND resp.approved_at IS NOT NULL
        AND resp.approved_at >= NOW() - make_interval(days => ?)
    `;
  const TREND_ACCOUNT = `
      SELECT gs::date AS week_start,
             agg.avg_score::float AS avg_score,
             COALESCE(agg.cnt, 0)::int AS cnt
      FROM generate_series(
        DATE_TRUNC('week', NOW() - make_interval(weeks => ?)),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN (
        SELECT DATE_TRUNC('week', r.detected_at)::date AS wk,
               AVG(r.sentiment_score) AS avg_score,
               COUNT(*) AS cnt
        FROM reviews r
        JOIN businesses b ON b.id = r.business_id
        WHERE b.account_id = ?
          AND b.archived_at IS NULL
          AND r.status <> ?
          AND r.detected_at >= NOW() - make_interval(weeks => ?)
        GROUP BY DATE_TRUNC('week', r.detected_at)
      ) agg ON agg.wk = gs::date
      ORDER BY week_start ASC
    `;

  it('getLocationKpiSummary emits the pinned text for all 5 queries, in order', async () => {
    seed();
    await getLocationKpiSummary(mockSql, 'biz-1');
    const texts = harness.sqlCalls.map((call) => call.text);
    expect(texts).toEqual([
      RATE_LOCATION, STAR_LOCATION, VOLUME_LOCATION, TTR_LOCATION, TREND_LOCATION,
    ]);
  });

  it('getAccountKpiSummary emits the pinned text for all 5 queries, in order', async () => {
    seed();
    await getAccountKpiSummary(mockSql, 'acct-1');
    const texts = harness.sqlCalls.map((call) => call.text);
    expect(texts).toEqual([
      RATE_ACCOUNT, STAR_ACCOUNT, VOLUME_ACCOUNT, TTR_ACCOUNT, TREND_ACCOUNT,
    ]);
  });

  it("REVIEW_STATUS.DELETED reaches SQL as a bound param, never a raw 'deleted' literal", async () => {
    seed();
    await getLocationKpiSummary(mockSql, 'biz-1');
    await getAccountKpiSummary(mockSql, 'acct-1');
    for (const call of harness.sqlCalls) {
      expect(call.text).not.toContain("'deleted'");
    }
    const deletedCount = harness.sqlCalls.filter((call) => call.values.includes('deleted')).length;
    // All 5 queries × 2 scopes filter reviews.status <> REVIEW_STATUS.DELETED.
    expect(deletedCount).toBe(10);
  });
});
