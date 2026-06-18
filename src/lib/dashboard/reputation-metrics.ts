// src/lib/dashboard/reputation-metrics.ts
//
// Windowed reputation/ROI metrics for the single-location dashboard hero.
// Each metric carries a typed, unit-correct delta vs the prior 30-day window
// plus the prior-window sample size, so the UI can render honest comparisons
// and suppress an individual arrow when its prior sample is zero.
//
// Per-metric windows (IMPLEMENTATION-PROMPT §B / locked PLAN.md §A.2):
//   • Response rate — denominator = reviews detected_at in window; numerator =
//     those whose approved response landed (approved_at) by the window's END.
//     Prior window's end = current window's start, so late approvals don't
//     retroactively inflate the prior-period rate.
//   • Avg star rating — windowed by detected_at.
//   • Time saved — windowed by owner-approval timestamp (approved_at), so a
//     delayed approval counts in the period it happened, not when the review
//     arrived. Minutes = handled count × MINUTES_SAVED_PER_RESPONSE (one shared
//     constant with the lifetime figure).
//
// Two FILTER-bucketed queries (reviews-keyed, responses-keyed) + the shared
// pending-count query run concurrently. If this regresses the dashboard p95 on
// staging (Phase F EXPLAIN gate), fall back to deferring non-hero deltas.

import { sql } from '@/lib/db/server';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import type { SentimentTrendPoint } from '@/lib/kpi/types';
import { MINUTES_SAVED_PER_RESPONSE } from './time-saved';
import { getPendingApprovalCount } from './pending-count';
import type { ReputationDelta, ReputationSummary } from './types';

const HANDLED = [...HANDLED_STATUSES] as string[];

/**
 * Location age (days) below which the prior-window deltas aren't yet
 * trustworthy. Default = 21 (three weeks) to match the "trends appear after a
 * few weeks" baseline copy; an ambiguous value per the plan, chosen here and
 * documented. While ramping, the hero renders compact (no arrows + baseline
 * copy) regardless of whether individual deltas exist.
 */
export const RAMPING_AGE_DAYS = 21;

interface ReviewsBucketRow {
  cur_received: number;
  cur_handled: number;
  cur_avg_star: number | null;
  prior_received: number;
  prior_handled: number;
  prior_avg_star: number | null;
  prior_star_count: number;
}

interface TimeBucketRow {
  cur_handled_count: number;
  prior_handled_count: number;
}

interface TrendRow {
  week_start: unknown;
  avg_score: unknown;
  cnt: unknown;
}

/** Map the 8-week sentiment trend rows (parallels kpi/service.ts mapTrend). */
function mapTrend(rows: TrendRow[]): SentimentTrendPoint[] {
  return rows.map((r) => ({
    weekStart: String(r.week_start),
    averageScore: r.avg_score == null ? null : round(Number(r.avg_score), 2),
    reviewCount: Number(r.cnt ?? 0),
  }));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Build a ReputationDelta, suppressing the delta when the prior sample is empty. */
function withDelta<T>(value: T, current: number | null, prior: number | null, priorSample: number, decimals: number): ReputationDelta<T> {
  const delta =
    priorSample > 0 && current != null && prior != null
      ? round(current - prior, decimals)
      : null;
  return { value, delta, priorSample };
}

export async function getReputationMetrics(
  businessId: string,
  locationCreatedAt: Date,
): Promise<ReputationSummary> {
  const [reviewsRows, timeRows, trendRows, pendingApprovalCount] = await Promise.all([
    sql<ReviewsBucketRow[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE r.detected_at >= NOW() - INTERVAL '30 days'
        )::int AS cur_received,
        COUNT(*) FILTER (
          WHERE r.detected_at >= NOW() - INTERVAL '30 days'
            AND EXISTS (
              SELECT 1 FROM responses resp
              WHERE resp.review_id = r.id
                AND resp.business_id = ${businessId}
                AND resp.status = ANY(${HANDLED}::text[])
                AND resp.approved_at IS NOT NULL
            )
        )::int AS cur_handled,
        AVG(r.star_rating) FILTER (
          WHERE r.detected_at >= NOW() - INTERVAL '30 days' AND r.star_rating IS NOT NULL
        )::float AS cur_avg_star,
        COUNT(*) FILTER (
          WHERE r.detected_at >= NOW() - INTERVAL '60 days' AND r.detected_at < NOW() - INTERVAL '30 days'
        )::int AS prior_received,
        COUNT(*) FILTER (
          WHERE r.detected_at >= NOW() - INTERVAL '60 days' AND r.detected_at < NOW() - INTERVAL '30 days'
            AND EXISTS (
              SELECT 1 FROM responses resp
              WHERE resp.review_id = r.id
                AND resp.business_id = ${businessId}
                AND resp.status = ANY(${HANDLED}::text[])
                AND resp.approved_at IS NOT NULL
                AND resp.approved_at <= NOW() - INTERVAL '30 days'
            )
        )::int AS prior_handled,
        AVG(r.star_rating) FILTER (
          WHERE r.detected_at >= NOW() - INTERVAL '60 days' AND r.detected_at < NOW() - INTERVAL '30 days'
            AND r.star_rating IS NOT NULL
        )::float AS prior_avg_star,
        COUNT(*) FILTER (
          WHERE r.detected_at >= NOW() - INTERVAL '60 days' AND r.detected_at < NOW() - INTERVAL '30 days'
            AND r.star_rating IS NOT NULL
        )::int AS prior_star_count
      FROM reviews r
      WHERE r.business_id = ${businessId}
        AND r.status <> 'deleted'
        AND r.detected_at >= NOW() - INTERVAL '60 days'
    `,
    sql<TimeBucketRow[]>`
      SELECT
        COUNT(*) FILTER (
          WHERE resp.approved_at >= NOW() - INTERVAL '30 days'
        )::int AS cur_handled_count,
        COUNT(*) FILTER (
          WHERE resp.approved_at >= NOW() - INTERVAL '60 days' AND resp.approved_at < NOW() - INTERVAL '30 days'
        )::int AS prior_handled_count
      FROM responses resp
      JOIN reviews r ON r.id = resp.review_id
      WHERE r.business_id = ${businessId}
        AND r.status <> 'deleted'
        AND resp.status = ANY(${HANDLED}::text[])
        AND resp.approved_at IS NOT NULL
        AND resp.approved_at >= NOW() - INTERVAL '60 days'
    `,
    // 8-week sentiment trend (zero-filled), parallels kpi/service.ts so the
    // dashboard renders the chart from this ONE response, no /api/dashboard/kpis
    // second fetch. AVG(sentiment_score) is on a -1..1 scale; the UI maps it to
    // a star-equivalent for display (never shown as a raw score).
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
    getPendingApprovalCount(businessId),
  ]);

  const rev = reviewsRows[0];
  const time = timeRows[0];

  // ── Response rate (percentage points) ─────────────────────────────────────
  const curReceived = rev?.cur_received ?? 0;
  const curHandled = rev?.cur_handled ?? 0;
  const priorReceived = rev?.prior_received ?? 0;
  const priorHandled = rev?.prior_handled ?? 0;
  const curRate = curReceived > 0 ? Math.round((curHandled / curReceived) * 100) : null;
  const priorRate = priorReceived > 0 ? Math.round((priorHandled / priorReceived) * 100) : null;
  const responseRate = withDelta(curRate, curRate, priorRate, priorReceived, 0);

  // ── Average star rating (rating points) ───────────────────────────────────
  const curAvgStar = rev?.cur_avg_star ?? null;
  const priorAvgStar = rev?.prior_avg_star ?? null;
  const priorStarCount = rev?.prior_star_count ?? 0;
  const averageStarRating = withDelta(
    curAvgStar == null ? null : round(curAvgStar, 2),
    curAvgStar,
    priorAvgStar,
    priorStarCount,
    2,
  );

  // ── Time saved (minutes) ──────────────────────────────────────────────────
  const curTimeCount = time?.cur_handled_count ?? 0;
  const priorTimeCount = time?.prior_handled_count ?? 0;
  const timeSavedMinutes = withDelta(
    curTimeCount * MINUTES_SAVED_PER_RESPONSE,
    curTimeCount * MINUTES_SAVED_PER_RESPONSE,
    priorTimeCount * MINUTES_SAVED_PER_RESPONSE,
    priorTimeCount,
    0,
  );

  return {
    averageStarRating,
    responseRate,
    timeSavedMinutes,
    ramping: isRamping(locationCreatedAt),
    pendingApprovalCount,
    sentimentTrend: mapTrend(trendRows),
  };
}

function isRamping(createdAt: Date): boolean {
  const ageMs = Date.now() - createdAt.getTime();
  if (Number.isNaN(ageMs)) return false;
  return ageMs < RAMPING_AGE_DAYS * 86_400_000;
}
