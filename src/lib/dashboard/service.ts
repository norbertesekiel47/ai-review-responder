// src/lib/dashboard/service.ts
//
// Builds DashboardDataActive for owners with an active subscription
// and a completed onboarding wizard. The route handler runs preflight
// checks and only calls this when the active dashboard path applies.
//
// See docs/superpowers/specs/2026-04-26-modularization-design.md §7.1.

import { sql } from '@/lib/db/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import {
  HANDLED_STATUSES,
  RECENT_REVIEW_DISPLAY_STATUSES,
} from '@/lib/shared/response-status';
import { pendingKey } from '@/lib/zernio/connect-state';
import type { DashboardDataActive } from './types';
import {
  buildActiveDashboardResponse,
  type DashboardBriefRow,
  type DashboardBusinessRow,
  type DashboardRankingRow,
  type DashboardZernioConnectionRow,
} from './service-mappers';
import { getPendingApprovalCount } from './pending-count';
import {
  buildReputationSummary,
  type RateWindowRow,
  type StarWindowRow,
  type TimeSavedWindowRow,
  type SentimentTrendRow,
} from './reputation-summary';

const HANDLED = [...HANDLED_STATUSES] as string[];

/**
 * Thrown when the businesses row vanishes between the route's preflight
 * SELECT and the service's 8-query assembly. Extremely rare in practice
 * (TOCTOU window is sub-millisecond and no normal flow deletes a business
 * out from under an authenticated owner), but kept as an explicit signal
 * so the route can return 404 instead of 500.
 */
export class BusinessNotFoundError extends Error {
  constructor(businessId: string) {
    super(`Business not found: ${businessId}`);
    this.name = 'BusinessNotFoundError';
  }
}

export async function getActiveDashboardData(
  businessId: string,
  opts?: { includeReputationMetrics?: boolean },
): Promise<DashboardDataActive> {
  const [
    businessRows,
    totalReviewRows,
    totalRespondedRows,
    velocityRows,
    rankingRows,
    recentReviewRows,
    monthlyBriefRows,
    weeklyBriefRows,
    zernioConnectionRows,
    queuedReconnectRows,
    unresolvedIncidentRows,
    pendingRaw,
  ] = await Promise.all([
    // Business info + settings
    sql<DashboardBusinessRow[]>`
      SELECT b.name, b.created_at, b.initial_review_count, b.initial_responded_count, b.baseline_captured_at,
             b.tone, b.products_services, b.avoid_facts, b.sample_responses,
             b.owner_phone, b.owner_email,
             a.weekly_summary_enabled, a.monthly_impact_enabled,
             b.category, b.google_place_id
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      WHERE b.id = ${businessId}
      LIMIT 1
    `,
    // Total reviews (all time)
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> 'deleted'
    `,
    // Total responded (distinct reviews with non-superseded responses)
    sql<{ count: number }[]>`
      SELECT COUNT(DISTINCT r.id)::int AS count
      FROM reviews r
      JOIN responses resp ON resp.review_id = r.id
      WHERE r.business_id = ${businessId}
        AND r.status <> 'deleted'
        AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    `,
    // Review velocity: last 8 weeks (zero-filled)
    sql<{ week_start: unknown; count: unknown }[]>`
      SELECT gs::date AS week_start,
             COALESCE(r.cnt, 0)::int AS count
      FROM generate_series(
        DATE_TRUNC('week', NOW() - INTERVAL '7 weeks'),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN (
        SELECT DATE_TRUNC('week', detected_at)::date AS wk, COUNT(*) AS cnt
        FROM reviews
        WHERE business_id = ${businessId}
          AND detected_at >= NOW() - INTERVAL '8 weeks'
          AND status <> 'deleted'
        GROUP BY DATE_TRUNC('week', detected_at)
      ) r ON r.wk = gs::date
      ORDER BY week_start ASC
    `,
    // Ranking snapshots (all with rank_position)
    sql<DashboardRankingRow[]>`
      SELECT keyword, snapshot_date, rank_position
      FROM ranking_snapshots
      WHERE business_id = ${businessId}
        AND rank_position IS NOT NULL
        AND snapshot_date >= (CURRENT_DATE - INTERVAL '12 months')
      ORDER BY keyword ASC, snapshot_date ASC
    `,
    // Recent reviews: last 10 with latest non-superseded/failed response
    // Include pending_approval so the UI can show "check your email" reminders
    sql<Record<string, unknown>[]>`
      SELECT
        rev.id,
        rev.reviewer_name,
        rev.star_rating,
        rev.review_text,
        rev.review_date,
        rev.status,
        resp.response_text,
        resp.status AS response_status,
        resp.approval_method
      FROM reviews rev
      LEFT JOIN LATERAL (
        SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method
        FROM responses
        WHERE review_id = rev.id
          -- Explicit tenant scope: responses belong to the same location as the
          -- review (defense-in-depth alongside the review_id correlation).
          AND business_id = ${businessId}
          AND status = ANY(${[...RECENT_REVIEW_DISPLAY_STATUSES] as string[]}::text[])
          -- Held-for-review drafts (high-severity moderation flag still open)
          -- must never surface to the owner UI; the admin queue owns them.
          AND NOT EXISTS (
            SELECT 1 FROM flagged_responses fr
            WHERE fr.response_id = responses.id AND fr.status = 'open'
          )
        ORDER BY version DESC
        LIMIT 1
      ) resp ON true
      WHERE rev.business_id = ${businessId}
        AND rev.status <> 'deleted'
      ORDER BY rev.detected_at DESC
      LIMIT 10
    `,
    // Latest monthly brief (with sent_at for recency comparison)
    sql<DashboardBriefRow[]>`
      SELECT summary_text, month_start_date, sent_at
      FROM monthly_impact_emails
      WHERE business_id = ${businessId}
        AND summary_text IS NOT NULL
        AND sent_at IS NOT NULL
      ORDER BY sent_at DESC
      LIMIT 1
    `,
    // Latest weekly brief (with sent_at for recency comparison)
    sql<DashboardBriefRow[]>`
      SELECT summary_text, week_start_date, sent_at
      FROM weekly_summaries
      WHERE business_id = ${businessId}
        AND summary_text IS NOT NULL
        AND sent_at IS NOT NULL
      ORDER BY sent_at DESC
      LIMIT 1
    `,
    // Zernio connection: most-recent row (any status). Banner state machine
    // distinguishes 'none' (no row) from 'disconnected' (row with status='disconnected').
    sql<DashboardZernioConnectionRow[]>`
      SELECT status, disconnect_reason
      FROM zernio_connections
      WHERE business_id = ${businessId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    // Queued-for-reconnect responses: approved drafts parked while Zernio is
    // disconnected. Drives banner headline copy ("3 responses are waiting...").
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM responses
      WHERE business_id = ${businessId}
        AND status = 'awaiting_owner_connect'
    `,
    // Unresolved finalize incident: takes priority over the connection status —
    // owner sees "manual review" banner regardless of zernio_connections state.
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM zernio_finalize_incidents
      WHERE business_id = ${businessId}
        AND resolved_at IS NULL
    `,
    // In-flight connect flow marker. Lives in Redis only — the DB row
    // (zernio_connections) is not inserted until select-location succeeds.
    // Surfacing this lets the dashboard render a "Connecting…" UX during the
    // OAuth + finalize window instead of falling back to "Connect" which
    // would 409 on retry and confuse the owner.
    readPendingMarker(businessId),
  ]);

  const business = businessRows[0];
  if (!business) {
    throw new BusinessNotFoundError(businessId);
  }

  const totalReviews = totalReviewRows[0]?.count ?? 0;
  const totalResponded = totalRespondedRows[0]?.count ?? 0;

  // Opt-in reputation batch (single-location landing only). Runs after the main
  // batch; its windowed queries are internally parallel (one FILTER query per
  // metric). Aggregate/connect callers omit the flag and pay nothing.
  const reputationRows = opts?.includeReputationMetrics
    ? await fetchReputationRows(businessId)
    : null;
  const reputationSummary = reputationRows
    ? buildReputationSummary({
        ...reputationRows,
        accountAgeDays: daysSince(business.created_at),
      })
    : undefined;

  // Zernio banner precedence (finalize-incident > active > pending marker >
  // connection status > none) is owned by resolveZernioConnectionState in
  // zernio-banner.ts — see there for the authoritative rules.
  return buildActiveDashboardResponse({
    business,
    totalReviews,
    totalResponded,
    velocityRows,
    rankingRows,
    recentReviewRows,
    monthlyBrief: monthlyBriefRows[0],
    weeklyBrief: weeklyBriefRows[0],
    zernioRow: zernioConnectionRows[0],
    queuedReconnectCount: queuedReconnectRows[0]?.count ?? 0,
    hasUnresolvedIncident: (unresolvedIncidentRows[0]?.count ?? 0) > 0,
    pendingRaw,
    reputationSummary,
  });
}

function daysSince(date: Date): number {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}

/**
 * Windowed reputation metrics: current 30-day vs prior 30-day buckets via
 * FILTER (single round-trip per metric), plus the 8-week sentiment trend and
 * the authoritative pending-approval count. Response-rate history uses
 * `approved_at <= prior window end` so late approvals don't retro-inflate the
 * prior period (PLAN.md A.2). All scoped by business_id.
 */
async function fetchReputationRows(businessId: string): Promise<{
  rate: RateWindowRow;
  star: StarWindowRow;
  timeSaved: TimeSavedWindowRow;
  trend: SentimentTrendRow[];
  pendingApprovalCount: number;
}> {
  const [rateRows, starRows, timeSavedRows, trendRows, pendingApprovalCount] =
    await Promise.all([
      sql<RateWindowRow[]>`
        SELECT
          COUNT(*) FILTER (
            WHERE r.detected_at >= NOW() - INTERVAL '30 days'
          )::int AS received_current,
          COUNT(*) FILTER (
            WHERE r.detected_at >= NOW() - INTERVAL '30 days'
              AND EXISTS (
                SELECT 1 FROM responses resp
                WHERE resp.review_id = r.id
                  AND resp.business_id = ${businessId}
                  AND resp.status = ANY(${HANDLED}::text[])
              )
          )::int AS handled_current,
          COUNT(*) FILTER (
            WHERE r.detected_at >= NOW() - INTERVAL '60 days'
              AND r.detected_at < NOW() - INTERVAL '30 days'
          )::int AS received_prior,
          COUNT(*) FILTER (
            WHERE r.detected_at >= NOW() - INTERVAL '60 days'
              AND r.detected_at < NOW() - INTERVAL '30 days'
              AND EXISTS (
                SELECT 1 FROM responses resp
                WHERE resp.review_id = r.id
                  AND resp.business_id = ${businessId}
                  AND resp.status = ANY(${HANDLED}::text[])
                  AND resp.approved_at IS NOT NULL
                  AND resp.approved_at <= NOW() - INTERVAL '30 days'
              )
          )::int AS handled_prior
        FROM reviews r
        WHERE r.business_id = ${businessId}
          AND r.status <> 'deleted'
          AND r.detected_at >= NOW() - INTERVAL '60 days'
      `,
      sql<StarWindowRow[]>`
        SELECT
          AVG(star_rating) FILTER (
            WHERE detected_at >= NOW() - INTERVAL '30 days'
          )::float AS star_current,
          COUNT(star_rating) FILTER (
            WHERE detected_at >= NOW() - INTERVAL '30 days'
          )::int AS star_n_current,
          AVG(star_rating) FILTER (
            WHERE detected_at >= NOW() - INTERVAL '60 days'
              AND detected_at < NOW() - INTERVAL '30 days'
          )::float AS star_prior,
          COUNT(star_rating) FILTER (
            WHERE detected_at >= NOW() - INTERVAL '60 days'
              AND detected_at < NOW() - INTERVAL '30 days'
          )::int AS star_n_prior
        FROM reviews
        WHERE business_id = ${businessId}
          AND status <> 'deleted'
          AND star_rating IS NOT NULL
          AND detected_at >= NOW() - INTERVAL '60 days'
      `,
      sql<TimeSavedWindowRow[]>`
        SELECT
          COUNT(*) FILTER (
            WHERE resp.approved_at >= NOW() - INTERVAL '30 days'
          )::int AS handled_current,
          COUNT(*) FILTER (
            WHERE resp.approved_at >= NOW() - INTERVAL '60 days'
              AND resp.approved_at < NOW() - INTERVAL '30 days'
          )::int AS handled_prior
        FROM responses resp
        JOIN reviews r ON r.id = resp.review_id
        WHERE r.business_id = ${businessId}
          AND resp.business_id = ${businessId}
          AND r.status <> 'deleted'
          AND resp.status = ANY(${HANDLED}::text[])
          AND resp.approved_at IS NOT NULL
          AND resp.approved_at >= NOW() - INTERVAL '60 days'
      `,
      sql<SentimentTrendRow[]>`
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

  return {
    rate: rateRows[0] ?? {
      received_current: 0,
      handled_current: 0,
      received_prior: 0,
      handled_prior: 0,
    },
    star: starRows[0] ?? {
      star_current: null,
      star_n_current: 0,
      star_prior: null,
      star_n_prior: 0,
    },
    timeSaved: timeSavedRows[0] ?? { handled_current: 0, handled_prior: 0 },
    trend: trendRows,
    pendingApprovalCount,
  };
}

async function readPendingMarker(businessId: string): Promise<string | null> {
  // Pending-marker read is wrapped so a Redis outage degrades gracefully. The
  // dashboard never depends on this value being available; it only upgrades
  // the UX during an in-flight connect flow.
  try {
    return await getCacheRedis().get(pendingKey(businessId));
  } catch (err) {
    console.error(
      '[dashboard/service] failed to read connect_pending marker:',
      err,
    );
    return null;
  }
}
