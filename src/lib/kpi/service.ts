// src/lib/kpi/service.ts
//
// Launch KPI layer (Spec 11). Windowed metrics scoped per-location (business_id)
// or per-account (active locations). Mirrors dashboard/service.ts query style.
// Does NOT overload valueSummary (lifetime). No real-DB test — keep SQL standard.

import { sql } from '@/lib/db/server';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import {
  DashboardKpiSummary,
  KPI_WINDOW_DAYS,
  KpiScope,
} from './types';

const HANDLED = [...HANDLED_STATUSES] as string[];

function round(value: number | null, decimals: number): number | null {
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

function assembleSummary(
  scope: KpiScope,
  rateRows: RateRow[],
  starRows: StarRow[],
  volumeRows: VolumeRow[],
  ttrRows: TtrRow[],
  trendRows: TrendRow[],
): DashboardKpiSummary {
  const received = rateRows[0]?.received ?? 0;
  const handled = rateRows[0]?.handled ?? 0;
  const current = volumeRows[0]?.current_month ?? 0;
  const prior = volumeRows[0]?.prior_month ?? 0;
  return {
    scope,
    windowDays: KPI_WINDOW_DAYS,
    responseRate: { handled, received, ratePct: ratePct(handled, received) },
    averageStarRating: round(starRows[0]?.avg ?? null, 2),
    reviewVolume: { currentMonth: current, priorMonth: prior, deltaPct: deltaPct(current, prior) },
    averageTimeToRespondHours: round(ttrRows[0]?.avg_hours ?? null, 1),
    sentimentTrend: mapTrend(trendRows),
  };
}

export async function getLocationKpiSummary(
  businessId: string,
): Promise<DashboardKpiSummary> {
  // The SQL INTERVAL literals below correspond to KPI_WINDOW_DAYS (30) and
  // SENTIMENT_TREND_WEEKS (8) from ./types. They are kept as inline literals
  // because Postgres.js interval parameters cannot interpolate a TS constant —
  // keep them in sync if those constants change.
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
        AND r.detected_at >= NOW() - INTERVAL '30 days'
    `,
    sql<StarRow[]>`
      SELECT AVG(star_rating)::float AS avg
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> 'deleted'
        AND star_rating IS NOT NULL
        AND detected_at >= NOW() - INTERVAL '30 days'
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
        AND resp.approved_at >= NOW() - INTERVAL '30 days'
    `,
    sql<TrendRow[]>`
      SELECT gs::date AS week_start,
             agg.avg_score::float AS avg_score,
             COALESCE(agg.cnt, 0)::int AS cnt
      FROM generate_series(
        DATE_TRUNC('week', NOW() - INTERVAL '7 weeks'),
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
          AND detected_at >= NOW() - INTERVAL '8 weeks'
        GROUP BY DATE_TRUNC('week', detected_at)
      ) agg ON agg.wk = gs::date
      ORDER BY week_start ASC
    `,
  ]);

  return assembleSummary(
    { kind: 'location', businessId },
    rateRows, starRows, volumeRows, ttrRows, trendRows,
  );
}

export async function getAccountKpiSummary(
  accountId: string,
): Promise<DashboardKpiSummary> {
  // Window intervals correspond to KPI_WINDOW_DAYS (30) and SENTIMENT_TREND_WEEKS (8);
  // kept as SQL literals (Postgres.js interval literals can't interpolate a TS constant).
  // Active locations only: b.archived_at IS NULL.
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
        AND r.detected_at >= NOW() - INTERVAL '30 days'
    `,
    sql<StarRow[]>`
      SELECT AVG(r.star_rating)::float AS avg
      FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      WHERE b.account_id = ${accountId}
        AND b.archived_at IS NULL
        AND r.status <> 'deleted'
        AND r.star_rating IS NOT NULL
        AND r.detected_at >= NOW() - INTERVAL '30 days'
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
        AND resp.approved_at >= NOW() - INTERVAL '30 days'
    `,
    sql<TrendRow[]>`
      SELECT gs::date AS week_start,
             agg.avg_score::float AS avg_score,
             COALESCE(agg.cnt, 0)::int AS cnt
      FROM generate_series(
        DATE_TRUNC('week', NOW() - INTERVAL '7 weeks'),
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
          AND r.detected_at >= NOW() - INTERVAL '8 weeks'
        GROUP BY DATE_TRUNC('week', r.detected_at)
      ) agg ON agg.wk = gs::date
      ORDER BY week_start ASC
    `,
  ]);

  return assembleSummary(
    { kind: 'account', accountId },
    rateRows, starRows, volumeRows, ttrRows, trendRows,
  );
}
