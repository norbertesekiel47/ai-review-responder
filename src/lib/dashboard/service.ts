// src/lib/dashboard/service.ts
//
// Builds DashboardDataActive for owners with an active subscription
// and a completed onboarding wizard. The route handler runs preflight
// checks and only calls this when the active dashboard path applies.
//
// See docs/superpowers/specs/2026-04-26-modularization-design.md §7.1.

import type { Sql } from 'postgres';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  HANDLED_STATUSES,
  RECENT_REVIEW_DISPLAY_STATUSES,
} from '@/lib/shared/response-status';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import {
  type DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
  dashboardWindowParams,
} from '@/lib/kpi/types';
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

// Short TTL cache for the per-location payload, mirroring the aggregate-service
// fail-open block (#487). This is the single-location landing's 14-query batch,
// so repeated loads within the TTL — tab switches, the KPI poll, several owners
// of the same location — reuse one computation. 45s staleness is invisible next
// to the pipeline's own multi-second latency.
const DASHBOARD_LOCATION_CACHE_TTL_SECONDS = 45;

interface ActiveDashboardOpts {
  includeReputationMetrics?: boolean;
  window?: DashboardWindow;
  /** Pre-fetched business+settings row (route preflight already joined
   *  businesses×accounts) — skips this function's own business query.
   *  Callers passing it own the guarantee that the row IS businessId's. */
  business?: DashboardBusinessRow;
}

// The payload is identical whether `opts.business` was pre-fetched or queried
// (that flag is a query-skip optimization, not a different result), so it must
// NOT vary the cache key — only the tenant, window, and reputation-metrics flag
// change the output.
function locationCacheKey(businessId: string, opts?: ActiveDashboardOpts): string {
  const window = opts?.window ?? DEFAULT_DASHBOARD_WINDOW;
  const includeReputationMetrics = opts?.includeReputationMetrics ?? false;
  return `dashboard:location:${businessId}:${window}:${includeReputationMetrics ? 'rep' : 'norep'}`;
}

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

/**
 * Per-widget degradation (prod-hardening spec P10): one auxiliary widget
 * query failing must not 500 the whole dashboard. The failure is reported
 * (never silent) and the widget renders its empty state. Only the business
 * lookup stays fatal — a dashboard for a missing business is meaningless.
 *
 * Shared with the aggregate path (aggregate-service.ts), which passes
 * `{ accountId }` context instead of `{ businessId }`.
 */
export function widgetOrFallback<T>(
  result: PromiseSettledResult<T>,
  fallback: T,
  widget: string,
  context: Record<string, string>,
): T {
  if (result.status === 'fulfilled') return result.value;
  reportCaughtError('dashboard/service', result.reason, {
    ...context,
    widget,
    degraded: true,
  });
  return fallback;
}

export async function getActiveDashboardData(
  sql: Sql,
  businessId: string,
  opts?: ActiveDashboardOpts,
): Promise<DashboardDataActive> {
  // Cache read fails open: a Redis blip degrades to a fresh computation.
  const cacheKey = locationCacheKey(businessId, opts);
  try {
    const cached = await getCacheRedis().get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as DashboardDataActive;
    }
  } catch (err) {
    console.error('[dashboard/service] cache read failed (computing fresh):', err);
  }

  // BusinessNotFoundError throws inside the compute (missing business row),
  // before the set below — so a 404 signal is never cached.
  const data = await buildActiveDashboardData(sql, businessId, opts);

  try {
    await getCacheRedis().set(
      cacheKey,
      JSON.stringify(data),
      'EX',
      DASHBOARD_LOCATION_CACHE_TTL_SECONDS,
    );
  } catch (err) {
    console.error('[dashboard/service] cache write failed (serving fresh):', err);
  }

  return data;
}

async function buildActiveDashboardData(
  sql: Sql,
  businessId: string,
  opts?: ActiveDashboardOpts,
): Promise<DashboardDataActive> {
  // Velocity + reputation windows are PARAMETERIZED from the analytics window
  // (issue #403). `30d` (default) reproduces the legacy 30-day / 8-week behavior.
  // Intervals reach SQL only as bound integers via make_interval(...).
  const { windowDays, trendWeeks } = dashboardWindowParams(
    opts?.window ?? DEFAULT_DASHBOARD_WINDOW,
  );
  const velocitySpanWeeks = trendWeeks - 1;
  // P10 fail-fast shape (plan R2): the fatal business lookup runs OUTSIDE the
  // allSettled batch so its rejection surfaces immediately instead of waiting
  // for all 13 auxiliaries to settle (up to statement_timeout, 30s).
  // Promise.resolve() adopts the lazy Postgres.js thenable up front, starting
  // the query before the auxiliary batch is built; the settled batch already
  // has handlers attached, so an early throw leaves no unhandled rejection.
  // Business info + settings (skipped when the route already fetched it).
  const businessPromise: Promise<DashboardBusinessRow[]> = Promise.resolve(
    opts?.business
      ? [opts.business]
      : sql<DashboardBusinessRow[]>`
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
  );
  const settledPromise = Promise.allSettled([
    // Total reviews (all time)
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> ${REVIEW_STATUS.DELETED}
    `,
    // Total responded (distinct reviews with non-superseded responses)
    sql<{ count: number }[]>`
      SELECT COUNT(DISTINCT r.id)::int AS count
      FROM reviews r
      JOIN responses resp ON resp.review_id = r.id
      WHERE r.business_id = ${businessId}
        AND r.status <> ${REVIEW_STATUS.DELETED}
        AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    `,
    // Review velocity: last `trendWeeks` weeks (zero-filled), window-driven.
    sql<{ week_start: unknown; count: unknown }[]>`
      SELECT gs::date AS week_start,
             COALESCE(r.cnt, 0)::int AS count
      FROM generate_series(
        DATE_TRUNC('week', NOW() - make_interval(weeks => ${velocitySpanWeeks})),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN (
        SELECT DATE_TRUNC('week', detected_at)::date AS wk, COUNT(*) AS cnt
        FROM reviews
        WHERE business_id = ${businessId}
          AND detected_at >= NOW() - make_interval(weeks => ${trendWeeks})
          AND status <> ${REVIEW_STATUS.DELETED}
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
        resp.approval_method,
        resp.auto_post_scheduled_at,
        esc.id AS escalation_id,
        esc.status AS escalation_status,
        esc.triage_severity AS escalation_severity
      FROM reviews rev
      LEFT JOIN LATERAL (
        SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at
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
      LEFT JOIN LATERAL (
        SELECT id, status, triage_severity
        FROM review_escalations e
        WHERE e.review_id = rev.id
          -- Explicit tenant scope (defense-in-depth, mirrors the resp join).
          AND e.business_id = ${businessId}
          -- Status literal kept deliberately: it matches the
          -- review_escalations_one_open_per_review partial-index predicate
          -- byte-for-byte so the planner can use that index; a bound
          -- parameter could defeat the partial-index proof under a generic
          -- plan.
          AND e.status <> 'resolved'
        LIMIT 1
      ) esc ON true
      WHERE rev.business_id = ${businessId}
        AND rev.status <> ${REVIEW_STATUS.DELETED}
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
    // Reviews-by-rating breakdown (#405): true 1–5★ distribution across the
    // selected window — NOT the recentReviews sample. star_rating is
    // INTEGER CHECK (1..5) or NULL (migration 001), so a direct GROUP BY is
    // exact. The window reaches SQL only as a bound integer via make_interval
    // (issue #403); zero-fill + ordering happen in buildRatingBreakdown.
    sql<{ stars: number; count: number }[]>`
      SELECT star_rating AS stars, COUNT(*)::int AS count
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> ${REVIEW_STATUS.DELETED}
        AND star_rating IS NOT NULL
        AND detected_at >= NOW() - make_interval(days => ${windowDays})
      GROUP BY star_rating
    `,
    // In-flight connect flow marker. Lives in Redis only — the DB row
    // (zernio_connections) is not inserted until select-location succeeds.
    // Surfacing this lets the dashboard render a "Connecting…" UX during the
    // OAuth + finalize window instead of falling back to "Connect" which
    // would 409 on retry and confuse the owner.
    readPendingMarker(businessId),
    // Opt-in reputation batch (single-location landing only), fetched in the
    // SAME parallel wave as the main batch — running it afterwards cost a full
    // extra pool round-trip wave per landing request. Aggregate/connect
    // callers omit the flag and pay nothing.
    opts?.includeReputationMetrics
      ? fetchReputationRows(sql, businessId, windowDays, trendWeeks)
      : Promise.resolve(null),
  ]);

  const businessRows = await businessPromise;
  const business = businessRows[0];
  if (!business) {
    throw new BusinessNotFoundError(businessId);
  }

  const [
    totalReviewSettled,
    totalRespondedSettled,
    velocitySettled,
    rankingSettled,
    recentReviewSettled,
    monthlyBriefSettled,
    weeklyBriefSettled,
    zernioConnectionSettled,
    queuedReconnectSettled,
    unresolvedIncidentSettled,
    ratingBreakdownSettled,
    pendingSettled,
    reputationSettled,
  ] = await settledPromise;

  // Fallbacks are typed (not bare []) so T infers as the plain row-array
  // type rather than Postgres.js's RowList intersection.
  const totalReviewRows = widgetOrFallback(totalReviewSettled, [] as { count: number }[], 'totalReviewRows', { businessId });
  const totalRespondedRows = widgetOrFallback(totalRespondedSettled, [] as { count: number }[], 'totalRespondedRows', { businessId });
  const velocityRows = widgetOrFallback(velocitySettled, [] as { week_start: unknown; count: unknown }[], 'velocityRows', { businessId });
  const rankingRows = widgetOrFallback(rankingSettled, [] as DashboardRankingRow[], 'rankingRows', { businessId });
  const recentReviewRows = widgetOrFallback(recentReviewSettled, [] as Record<string, unknown>[], 'recentReviewRows', { businessId });
  const monthlyBriefRows = widgetOrFallback(monthlyBriefSettled, [] as DashboardBriefRow[], 'monthlyBriefRows', { businessId });
  const weeklyBriefRows = widgetOrFallback(weeklyBriefSettled, [] as DashboardBriefRow[], 'weeklyBriefRows', { businessId });
  const zernioConnectionRows = widgetOrFallback(zernioConnectionSettled, [] as DashboardZernioConnectionRow[], 'zernioConnectionRows', { businessId });
  const queuedReconnectRows = widgetOrFallback(queuedReconnectSettled, [] as { count: number }[], 'queuedReconnectRows', { businessId });
  const unresolvedIncidentRows = widgetOrFallback(unresolvedIncidentSettled, [] as { count: number }[], 'unresolvedIncidentRows', { businessId });
  const ratingBreakdownRows = widgetOrFallback(ratingBreakdownSettled, [] as { stars: number; count: number }[], 'ratingBreakdownRows', { businessId });
  const pendingRaw = widgetOrFallback(pendingSettled, null, 'pendingRaw', { businessId });
  // Reputation degrades as ONE widget: fetchReputationRows batches its five
  // queries internally, so any failure inside nulls the whole summary.
  const reputationRows = widgetOrFallback(reputationSettled, null, 'reputationRows', { businessId });

  const totalReviews = totalReviewRows[0]?.count ?? 0;
  const totalResponded = totalRespondedRows[0]?.count ?? 0;

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
    ratingBreakdownRows,
    pendingRaw,
    reputationSummary,
  });
}

function daysSince(date: Date): number {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}

/**
 * Windowed reputation metrics: current vs prior `windowDays`-day buckets via
 * FILTER (single round-trip per metric), plus the `trendWeeks`-week sentiment
 * trend and the authoritative pending-approval count. Response-rate history uses
 * `approved_at <= prior window end` so late approvals don't retro-inflate the
 * prior period (PLAN.md A.2). All scoped by business_id. Intervals are
 * PARAMETERIZED (issue #403): `windowDays` / `priorEndDays` (= 2×windowDays) /
 * `trendWeeks` reach SQL only as bound integers via make_interval(...).
 */
async function fetchReputationRows(
  sql: Sql,
  businessId: string,
  windowDays: number,
  trendWeeks: number,
): Promise<{
  rate: RateWindowRow;
  star: StarWindowRow;
  timeSaved: TimeSavedWindowRow;
  trend: SentimentTrendRow[];
  pendingApprovalCount: number;
}> {
  const priorEndDays = windowDays * 2;
  const trendSpanWeeks = trendWeeks - 1;
  const [rateRows, starRows, timeSavedRows, trendRows, pendingApprovalCount] =
    await Promise.all([
      sql<RateWindowRow[]>`
        SELECT
          COUNT(*) FILTER (
            WHERE r.detected_at >= NOW() - make_interval(days => ${windowDays})
          )::int AS received_current,
          COUNT(*) FILTER (
            WHERE r.detected_at >= NOW() - make_interval(days => ${windowDays})
              AND EXISTS (
                SELECT 1 FROM responses resp
                WHERE resp.review_id = r.id
                  AND resp.business_id = ${businessId}
                  AND resp.status = ANY(${HANDLED}::text[])
              )
          )::int AS handled_current,
          COUNT(*) FILTER (
            WHERE r.detected_at >= NOW() - make_interval(days => ${priorEndDays})
              AND r.detected_at < NOW() - make_interval(days => ${windowDays})
          )::int AS received_prior,
          COUNT(*) FILTER (
            WHERE r.detected_at >= NOW() - make_interval(days => ${priorEndDays})
              AND r.detected_at < NOW() - make_interval(days => ${windowDays})
              AND EXISTS (
                SELECT 1 FROM responses resp
                WHERE resp.review_id = r.id
                  AND resp.business_id = ${businessId}
                  AND resp.status = ANY(${HANDLED}::text[])
                  AND resp.approved_at IS NOT NULL
                  AND resp.approved_at <= NOW() - make_interval(days => ${windowDays})
              )
          )::int AS handled_prior
        FROM reviews r
        WHERE r.business_id = ${businessId}
          AND r.status <> ${REVIEW_STATUS.DELETED}
          AND r.detected_at >= NOW() - make_interval(days => ${priorEndDays})
      `,
      sql<StarWindowRow[]>`
        SELECT
          AVG(star_rating) FILTER (
            WHERE detected_at >= NOW() - make_interval(days => ${windowDays})
          )::float AS star_current,
          COUNT(star_rating) FILTER (
            WHERE detected_at >= NOW() - make_interval(days => ${windowDays})
          )::int AS star_n_current,
          AVG(star_rating) FILTER (
            WHERE detected_at >= NOW() - make_interval(days => ${priorEndDays})
              AND detected_at < NOW() - make_interval(days => ${windowDays})
          )::float AS star_prior,
          COUNT(star_rating) FILTER (
            WHERE detected_at >= NOW() - make_interval(days => ${priorEndDays})
              AND detected_at < NOW() - make_interval(days => ${windowDays})
          )::int AS star_n_prior
        FROM reviews
        WHERE business_id = ${businessId}
          AND status <> ${REVIEW_STATUS.DELETED}
          AND star_rating IS NOT NULL
          AND detected_at >= NOW() - make_interval(days => ${priorEndDays})
      `,
      sql<TimeSavedWindowRow[]>`
        SELECT
          COUNT(*) FILTER (
            WHERE resp.approved_at >= NOW() - make_interval(days => ${windowDays})
          )::int AS handled_current,
          COUNT(*) FILTER (
            WHERE resp.approved_at >= NOW() - make_interval(days => ${priorEndDays})
              AND resp.approved_at < NOW() - make_interval(days => ${windowDays})
          )::int AS handled_prior
        FROM responses resp
        JOIN reviews r ON r.id = resp.review_id
        WHERE r.business_id = ${businessId}
          AND resp.business_id = ${businessId}
          AND r.status <> ${REVIEW_STATUS.DELETED}
          AND resp.status = ANY(${HANDLED}::text[])
          AND resp.approved_at IS NOT NULL
          AND resp.approved_at >= NOW() - make_interval(days => ${priorEndDays})
      `,
      sql<SentimentTrendRow[]>`
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
            AND status <> ${REVIEW_STATUS.DELETED}
            AND detected_at >= NOW() - make_interval(weeks => ${trendWeeks})
          GROUP BY DATE_TRUNC('week', detected_at)
        ) agg ON agg.wk = gs::date
        ORDER BY week_start ASC
      `,
      getPendingApprovalCount(sql, businessId),
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
    // Pre-existing graceful degradation, made visible in Sentry (P10 R2) —
    // a console line alone left this failure mode silent in production.
    reportCaughtError('dashboard/service', err, {
      businessId,
      widget: 'pendingMarker',
      degraded: true,
    });
    return null;
  }
}
