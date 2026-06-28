// src/lib/kpi/service.ts
//
// Launch KPI layer (Spec 11). Windowed metrics scoped per-location (business_id)
// or per-account (active locations). Mirrors dashboard/service.ts query style.
// Does NOT overload valueSummary (lifetime). No real-DB test — keep SQL standard.

import { sql } from '@/lib/db/server';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import {
  DashboardKpiSummary,
  DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
  dashboardWindowParams,
  KpiScope,
} from './types';

const HANDLED = [...HANDLED_STATUSES] as string[];

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

export async function getLocationKpiSummary(
  businessId: string,
  window: DashboardWindow = DEFAULT_DASHBOARD_WINDOW,
): Promise<DashboardKpiSummary> {
  // Window intervals are PARAMETERIZED: windowDays / trendWeeks come from the
  // fixed lookup in ./types and reach SQL only as bound integers via
  // make_interval(...) — never interpolated text (issue #403). `30d` (default)
  // reproduces the legacy 30-day / 8-week behavior exactly. reviewVolume stays
  // calendar-month regardless of window, per the KpiReviewVolume contract.
  const { windowDays, trendWeeks } = dashboardWindowParams(window);
  const trendSpanWeeks = trendWeeks - 1;
  const [rateRows, starRows, volumeRows, ttrRows, trendRows] = await Promise.all([
    sql<RateRow[]>`
      SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM responses resp
            WHERE resp.review_id = r.id
              AND resp.status = ANY(${HANDLED}::text[])
          )
        )::int AS handled
      FROM reviews r
      WHERE r.business_id = ${businessId}
        AND r.status <> 'deleted'
        AND r.detected_at >= NOW() - make_interval(days => ${windowDays})
    `,
    sql<StarRow[]>`
      SELECT AVG(star_rating)::float AS avg
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> 'deleted'
        AND star_rating IS NOT NULL
        AND detected_at >= NOW() - make_interval(days => ${windowDays})
    `,
    sql<VolumeRow[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE detected_at >= DATE_TRUNC('month', NOW())
        )::int AS current_month,
        COUNT(*) FILTER (
          WHERE detected_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
            AND detected_at < DATE_TRUNC('month', NOW())
        )::int AS prior_month
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> 'deleted'
    `,
    sql<TtrRow[]>`
      SELECT AVG(EXTRACT(EPOCH FROM (resp.approved_at - r.detected_at)) / 3600.0)::float AS avg_hours
      FROM responses resp
      JOIN reviews r ON r.id = resp.review_id
      WHERE r.business_id = ${businessId}
        AND r.status <> 'deleted'
        AND resp.status = ANY(${HANDLED}::text[])
        AND resp.approved_at IS NOT NULL
        AND resp.approved_at >= NOW() - make_interval(days => ${windowDays})
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
        SELECT DATE_TRUNC('week', detected_at)::date AS wk,
               AVG(sentiment_score) AS avg_score,
               COUNT(*) AS cnt
        FROM reviews
        WHERE business_id = ${businessId}
          AND status <> 'deleted'
          AND detected_at >= NOW() - make_interval(weeks => ${trendWeeks})
        GROUP BY DATE_TRUNC('week', detected_at)
      ) agg ON agg.wk = gs::date
      ORDER BY week_start ASC
    `,
  ]);

  return assembleSummary(
    { kind: 'location', businessId },
    windowDays,
    rateRows, starRows, volumeRows, ttrRows, trendRows,
  );
}

export async function getAccountKpiSummary(
  accountId: string,
  window: DashboardWindow = DEFAULT_DASHBOARD_WINDOW,
): Promise<DashboardKpiSummary> {
  // Same parameterized-window contract as getLocationKpiSummary, across all
  // active locations of the account (b.archived_at IS NULL). Intervals are bound
  // integers via make_interval(...), never interpolated text (issue #403).
  const { windowDays, trendWeeks } = dashboardWindowParams(window);
  const trendSpanWeeks = trendWeeks - 1;
  const [rateRows, starRows, volumeRows, ttrRows, trendRows] = await Promise.all([
    sql<RateRow[]>`
      SELECT
        COUNT(*)::int AS received,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM responses resp
            WHERE resp.review_id = r.id
              AND resp.status = ANY(${HANDLED}::text[])
          )
        )::int AS handled
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND r.status <> 'deleted'
        AND r.detected_at >= NOW() - make_interval(days => ${windowDays})
    `,
    sql<StarRow[]>`
      SELECT AVG(r.star_rating)::float AS avg
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND r.status <> 'deleted'
        AND r.star_rating IS NOT NULL
        AND r.detected_at >= NOW() - make_interval(days => ${windowDays})
    `,
    sql<VolumeRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE r.detected_at >= DATE_TRUNC('month', NOW()))::int AS current_month,
        COUNT(*) FILTER (
          WHERE r.detected_at >= DATE_TRUNC('month', NOW()) - INTERVAL '1 month'
            AND r.detected_at < DATE_TRUNC('month', NOW())
        )::int AS prior_month
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND r.status <> 'deleted'
    `,
    sql<TtrRow[]>`
      SELECT AVG(EXTRACT(EPOCH FROM (resp.approved_at - r.detected_at)) / 3600.0)::float AS avg_hours
      FROM responses resp
      JOIN reviews r ON r.id = resp.review_id
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND r.status <> 'deleted'
        AND resp.status = ANY(${HANDLED}::text[])
        AND resp.approved_at IS NOT NULL
        AND resp.approved_at >= NOW() - make_interval(days => ${windowDays})
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
        SELECT DATE_TRUNC('week', r.detected_at)::date AS wk,
               AVG(r.sentiment_score) AS avg_score,
               COUNT(*) AS cnt
        FROM reviews r
        JOIN businesses b ON b.id = r.business_id
        WHERE b.account_id = ${accountId}
          AND b.archived_at IS NULL
          AND r.status <> 'deleted'
          AND r.detected_at >= NOW() - make_interval(weeks => ${trendWeeks})
        GROUP BY DATE_TRUNC('week', r.detected_at)
      ) agg ON agg.wk = gs::date
      ORDER BY week_start ASC
    `,
  ]);

  return assembleSummary(
    { kind: 'account', accountId },
    windowDays,
    rateRows, starRows, volumeRows, ttrRows, trendRows,
  );
}
