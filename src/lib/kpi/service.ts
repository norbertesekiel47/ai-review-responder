// src/lib/kpi/service.ts
//
// Launch KPI layer (Spec 11). Windowed metrics scoped per-location (business_id)
// or per-account (active locations). Mirrors dashboard/service.ts query style.
// Does NOT overload valueSummary (lifetime). Keep SQL standard — semantics are
// proven against real Postgres by __tests__/service.anchor.integration.test.ts.

import type { Sql } from 'postgres';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { reviewTimeAnchor, reviewTimeWindowFilter } from './fragments';
import {
  DashboardKpiSummary,
  DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
  dashboardWindowParams,
  KpiScope,
} from './types';

const HANDLED = [...HANDLED_STATUSES] as string[];

// Short TTL read cache for the KPI summaries, mirroring the #487
// aggregate-service fail-open block. The dashboard KPI strip is polled and
// re-fetched on tab switches; 45s of staleness is invisible next to the
// pipeline's own multi-second latency. Pure TTL, no dogpile lock — read and
// write both fail open to a fresh DB compute.
const KPI_CACHE_TTL_SECONDS = 45;

function locationKpiCacheKey(businessId: string, window: DashboardWindow): string {
  return `kpi:location:${businessId}:${window}`;
}

function accountKpiCacheKey(accountId: string, window: DashboardWindow): string {
  return `kpi:account:${accountId}:${window}`;
}

function round(value: number | null | undefined, decimals: number): number | null {
  if (value == null || Number.isNaN(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function ratePct(handled: number, received: number): number | null {
  return received > 0 ? Math.round((handled / received) * 100) : null;
}

function deltaPct(current: number, prior: number): number | null {
  return prior > 0 ? Math.round(((current - prior) / prior) * 100) : null;
}

function mapTrend(
  rows: Array<{ week_start: unknown; avg_score: unknown; cnt: unknown }>,
): DashboardKpiSummary['sentimentTrend'] {
  return rows.map((r) => ({
    weekStart: String(r.week_start),
    averageScore: r.avg_score == null ? null : round(Number(r.avg_score), 2),
    reviewCount: Number(r.cnt ?? 0),
  }));
}

type RateRow = { received: number; handled: number };
type StarRow = { avg: number | null };
type VolumeRow = { current_month: number; prior_month: number };
type TtrRow = { avg_hours: number | null };
type TrendRow = { week_start: unknown; avg_score: unknown; cnt: unknown };

// Empty-result sentinels keep assembleSummary free of per-field `?? 0`
// coalescing: an empty rows array yields these zeroed rows (same values the old
// inline defaults produced).
const EMPTY_RATE: RateRow = { received: 0, handled: 0 };
const EMPTY_VOLUME: VolumeRow = { current_month: 0, prior_month: 0 };

function assembleSummary(
  scope: KpiScope,
  windowDays: number,
  rateRows: RateRow[],
  starRows: StarRow[],
  volumeRows: VolumeRow[],
  ttrRows: TtrRow[],
  trendRows: TrendRow[],
): DashboardKpiSummary {
  const rate = rateRows[0] ?? EMPTY_RATE;
  const volume = volumeRows[0] ?? EMPTY_VOLUME;
  return {
    scope,
    windowDays,
    responseRate: { handled: rate.handled, received: rate.received, ratePct: ratePct(rate.handled, rate.received) },
    averageStarRating: round(starRows[0]?.avg, 2),
    reviewVolume: {
      currentMonth: volume.current_month,
      priorMonth: volume.prior_month,
      deltaPct: deltaPct(volume.current_month, volume.prior_month),
    },
    averageTimeToRespondHours: round(ttrRows[0]?.avg_hours, 1),
    sentimentTrend: mapTrend(trendRows),
  };
}

// ---------------------------------------------------------------------------
// Shared, non-scope query fragments.
//
// Each factory below returns a lazy Postgres.js fragment (a nested sql``
// template — never awaited on its own; it only composes into a caller's
// template's text + bound params, exactly like the mock in
// worker/__tests__/helpers/mock-sql.ts emulates). None of them spell a
// `FROM`/`JOIN` of a tenant table, so none of them can hide — or need — a
// tenant-scope predicate of their own.
//
// getLocationKpiSummary/getAccountKpiSummary keep their own FROM/JOIN +
// tenant-scope WHERE predicate (`r.business_id = `, `b.account_id = ` +
// `b.archived_at IS NULL`) written out literally in every query template:
// scripts/ci/tenant-scope-audit.ts reads only the raw, un-evaluated template
// text, so extracting that predicate (or its FROM/JOIN) into a fragment here
// would hide it from the scanner. Do not do that.
// ---------------------------------------------------------------------------

/** reviews soft-delete filter — every scope, every metric query. */
function notDeletedFilter(sql: Sql, prefix: '' | 'r.') {
  return prefix === 'r.'
    ? sql`r.status <> ${REVIEW_STATUS.DELETED}`
    : sql`status <> ${REVIEW_STATUS.DELETED}`;
}

/**
 * Rolling `detected_at` lookback — serves the response-rate query only
 * (workflow KPI — #688 keeps it on detected_at).
 */
function detectedAtWindowFilter(sql: Sql, prefix: '' | 'r.', windowDays: number) {
  return prefix === 'r.'
    ? sql`r.detected_at >= NOW() - make_interval(days => ${windowDays})`
    : sql`detected_at >= NOW() - make_interval(days => ${windowDays})`;
}

/** responses.status membership check against the handled-status vocabulary. */
function handledStatusFilter(sql: Sql, handled: string[]) {
  return sql`resp.status = ANY(${handled}::text[])`;
}

/**
 * Time-to-respond metric expression — identical for both scopes (always the
 * responses+reviews join). The `SELECT` keyword itself stays literal in each
 * caller's own template — never folded into this fragment — because
 * scripts/ci/tenant-scope-audit.ts's `hasReadOrMutationStatement` gate looks
 * for a literal select/update/delete keyword in the OUTER template text
 * before it will even look for a tenant-scope predicate; hiding it here would
 * make the audit silently skip scanning the caller's query altogether.
 */
function ttrSelectExpr(sql: Sql) {
  return sql`AVG(EXTRACT(EPOCH FROM (resp.approved_at - r.detected_at)) / 3600.0)::float AS avg_hours`;
}

/** Trailing time-to-respond filters after the tenant-scope predicate. */
function ttrHandledWindowFilter(sql: Sql, handled: string[], windowDays: number) {
  // approved_at >= r.detected_at: a pre-existing Google reply imported by
  // reconcileExternallyAnsweredReview carries its ORIGINAL timestamp, which
  // can predate detection — a negative duration is never our response
  // latency (#688; 16 rows at up to −2.9y measured on staging).
  return sql`${handledStatusFilter(sql, handled)}
        AND resp.approved_at IS NOT NULL
        AND resp.approved_at >= r.detected_at
        AND resp.approved_at >= NOW() - make_interval(days => ${windowDays})`;
}

export async function getLocationKpiSummary(
  sql: Sql,
  businessId: string,
  window: DashboardWindow = DEFAULT_DASHBOARD_WINDOW,
): Promise<DashboardKpiSummary> {
  // Cache read fails open: a Redis blip degrades to a fresh computation.
  const cacheKey = locationKpiCacheKey(businessId, window);
  try {
    const cached = await getCacheRedis().get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as DashboardKpiSummary;
    }
  } catch (err) {
    console.error('[kpi/service] cache read failed (computing fresh):', err);
  }

  // Window intervals are PARAMETERIZED: windowDays / trendWeeks come from the
  // fixed lookup in ./types and reach SQL only as bound integers via
  // make_interval(...) — never interpolated text (issue #403). `30d` (default)
  // reproduces the legacy 30-day / 8-week behavior exactly. reviewVolume stays
  // calendar-month regardless of window, per the KpiReviewVolume contract.
  const { windowDays, trendWeeks } = dashboardWindowParams(window);
  const trendSpanWeeks = trendWeeks - 1;
  // CONCURRENT AT FAN-OUT 5, POOL 8 (#505/#769 sweep). The only caller is
  // src/app/api/dashboard/kpis/route.ts, which passes `sqlRead` — the dedicated
  // read bulkhead whose max is clamped to [WEDGE_SAFE_READ_MIN,
  // READ_POOL_MAX_CEILING] = [8, 8] (src/lib/db/server.ts), NOT the singleton
  // `sql` at DB_POOL_MAX = 3. This wave is exactly what WEDGE_SAFE_READ_MIN was
  // sized for: 5 here, +1 for the route's concurrent subscription gate = 6 peak,
  // under 8. Adding members past 8 — or routing this onto `sql` — reintroduces
  // the wedge; both are deliberate decisions, not drive-by changes.
  const [rateRows, starRows, volumeRows, ttrRows, trendRows] = await Promise.all([
    sql<RateRow[]>`
      SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM responses resp
            WHERE resp.review_id = r.id
              AND ${handledStatusFilter(sql, HANDLED)}
          )
        )::int AS handled
      FROM reviews r
      WHERE r.business_id = ${businessId}
        AND ${notDeletedFilter(sql, 'r.')}
        AND ${detectedAtWindowFilter(sql, 'r.', windowDays)}
    `,
    sql<StarRow[]>`
      SELECT AVG(star_rating)::float AS avg
      FROM reviews
      WHERE business_id = ${businessId}
        AND ${notDeletedFilter(sql, '')}
        AND star_rating IS NOT NULL
        AND ${reviewTimeWindowFilter(sql, '', windowDays)}
    `,
    sql<VolumeRow[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE ${reviewTimeAnchor(sql, '')} >= DATE_TRUNC('month', NOW())
        )::int AS current_month,
        COUNT(*) FILTER (
          WHERE ${reviewTimeAnchor(sql, '')} >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
            AND ${reviewTimeAnchor(sql, '')} < DATE_TRUNC('month', NOW())
        )::int AS prior_month
      FROM reviews
      WHERE business_id = ${businessId}
        AND ${notDeletedFilter(sql, '')}
    `,
    sql<TtrRow[]>`
      SELECT ${ttrSelectExpr(sql)}
      FROM responses resp
      JOIN reviews r ON r.id = resp.review_id
      WHERE r.business_id = ${businessId}
        AND ${notDeletedFilter(sql, 'r.')}
        AND ${ttrHandledWindowFilter(sql, HANDLED, windowDays)}
    `,
    sql<TrendRow[]>`
      SELECT gs::date AS week_start,
             agg.avg_score::float AS avg_score,
             COALESCE(agg.cnt, 0)::int AS cnt
      FROM generate_series(
        DATE_TRUNC('week', NOW() - make_interval(weeks => ${trendSpanWeeks})),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN (
        SELECT DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})::date AS wk,
               AVG(sentiment_score) AS avg_score,
               COUNT(*) AS cnt
        FROM reviews
        WHERE business_id = ${businessId}
          AND ${notDeletedFilter(sql, '')}
          AND ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(weeks => ${trendWeeks})
        GROUP BY DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})
      ) agg ON agg.wk = gs::date
      ORDER BY week_start ASC
    `,
  ]);

  const summary = assembleSummary(
    { kind: 'location', businessId },
    windowDays,
    rateRows, starRows, volumeRows, ttrRows, trendRows,
  );

  // Cache write fails open: serve the fresh result even if the write throws.
  try {
    await getCacheRedis().set(cacheKey, JSON.stringify(summary), 'EX', KPI_CACHE_TTL_SECONDS);
  } catch (err) {
    console.error('[kpi/service] cache write failed (serving fresh):', err);
  }

  return summary;
}

export async function getAccountKpiSummary(
  sql: Sql,
  accountId: string,
  window: DashboardWindow = DEFAULT_DASHBOARD_WINDOW,
): Promise<DashboardKpiSummary> {
  // Cache read fails open: a Redis blip degrades to a fresh computation.
  const cacheKey = accountKpiCacheKey(accountId, window);
  try {
    const cached = await getCacheRedis().get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as DashboardKpiSummary;
    }
  } catch (err) {
    console.error('[kpi/service] cache read failed (computing fresh):', err);
  }

  // Same parameterized-window contract as getLocationKpiSummary, across all
  // active locations of the account (b.archived_at IS NULL). Intervals are bound
  // integers via make_interval(...), never interpolated text (issue #403).
  const { windowDays, trendWeeks } = dashboardWindowParams(window);
  const trendSpanWeeks = trendWeeks - 1;
  // CONCURRENT AT FAN-OUT 5, POOL 8 — same contract as getLocationKpiSummary
  // above; the caller (src/app/api/dashboard/kpis/route.ts) passes `sqlRead`,
  // and this wave runs concurrently with that route's subscription gate = 6 peak.
  const [rateRows, starRows, volumeRows, ttrRows, trendRows] = await Promise.all([
    sql<RateRow[]>`
      SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM responses resp
            WHERE resp.review_id = r.id
              AND ${handledStatusFilter(sql, HANDLED)}
          )
        )::int AS handled
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND ${notDeletedFilter(sql, 'r.')}
        AND ${detectedAtWindowFilter(sql, 'r.', windowDays)}
    `,
    sql<StarRow[]>`
      SELECT AVG(r.star_rating)::float AS avg
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND ${notDeletedFilter(sql, 'r.')}
        AND r.star_rating IS NOT NULL
        AND ${reviewTimeWindowFilter(sql, 'r.', windowDays)}
    `,
    sql<VolumeRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE ${reviewTimeAnchor(sql, 'r.')} >= DATE_TRUNC('month', NOW()))::int AS current_month,
        COUNT(*) FILTER (
          WHERE ${reviewTimeAnchor(sql, 'r.')} >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
            AND ${reviewTimeAnchor(sql, 'r.')} < DATE_TRUNC('month', NOW())
        )::int AS prior_month
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND ${notDeletedFilter(sql, 'r.')}
    `,
    sql<TtrRow[]>`
      SELECT ${ttrSelectExpr(sql)}
      FROM responses resp
      JOIN reviews r ON r.id = resp.review_id
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND ${notDeletedFilter(sql, 'r.')}
        AND ${ttrHandledWindowFilter(sql, HANDLED, windowDays)}
    `,
    sql<TrendRow[]>`
      SELECT gs::date AS week_start,
             agg.avg_score::float AS avg_score,
             COALESCE(agg.cnt, 0)::int AS cnt
      FROM generate_series(
        DATE_TRUNC('week', NOW() - make_interval(weeks => ${trendSpanWeeks})),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN (
        SELECT DATE_TRUNC('week', ${reviewTimeAnchor(sql, 'r.')})::date AS wk,
               AVG(r.sentiment_score) AS avg_score,
               COUNT(*) AS cnt
        FROM reviews r
        JOIN businesses b ON b.id = r.business_id
        WHERE b.account_id = ${accountId}
          AND b.archived_at IS NULL
          AND ${notDeletedFilter(sql, 'r.')}
          AND ${reviewTimeAnchor(sql, 'r.')} >= NOW() - make_interval(weeks => ${trendWeeks})
        GROUP BY DATE_TRUNC('week', ${reviewTimeAnchor(sql, 'r.')})
      ) agg ON agg.wk = gs::date
      ORDER BY week_start ASC
    `,
  ]);

  const summary = assembleSummary(
    { kind: 'account', accountId },
    windowDays,
    rateRows, starRows, volumeRows, ttrRows, trendRows,
  );

  // Cache write fails open: serve the fresh result even if the write throws.
  try {
    await getCacheRedis().set(cacheKey, JSON.stringify(summary), 'EX', KPI_CACHE_TTL_SECONDS);
  } catch (err) {
    console.error('[kpi/service] cache write failed (serving fresh):', err);
  }

  return summary;
}
