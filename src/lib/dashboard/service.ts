// src/lib/dashboard/service.ts
//
// Builds DashboardDataActive for owners with an active subscription
// and a completed onboarding wizard. The route handler runs preflight
// checks and only calls this when the active dashboard path applies.
//
// See docs/superpowers/specs/2026-04-26-modularization-design.md §7.1.

import type { Sql } from 'postgres';
import { getCacheRedis, withTtlCache } from '@/lib/db/redis-cache';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  HANDLED_STATUSES,
  RECENT_REVIEW_DISPLAY_STATUSES,
} from '@/lib/shared/response-status';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { settledInOrder } from '@/lib/shared/settled-in-order';
import {
  type DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
  dashboardWindowParams,
} from '@/lib/kpi/types';
import { reviewTimeAnchor, reviewTimeWindowFilter } from '@/lib/kpi/fragments';
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
import { openFlagExistsSql } from '@/lib/moderation/held-draft';
import {
  buildReputationSummary,
  type RateWindowRow,
  type StarWindowRow,
  type TimeSavedWindowRow,
  type SentimentTrendRow,
} from './reputation-summary';

const HANDLED = [...HANDLED_STATUSES] as string[];

/** One `GROUP BY star_rating` row: all-time total + windowed count per bucket. */
interface ReviewCountRow {
  stars: number | null;
  total_count: number;
  count: number;
}

/** One zero-filled week: velocity count + sentiment average (NULL when empty). */
interface WeeklySeriesRow {
  week_start: unknown;
  count: unknown;
  avg_score: unknown;
}

// Short TTL cache for the per-location payload, mirroring the aggregate-service
// fail-open block (#487). This is the single-location landing's 15-statement batch,
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
 * SELECT and the service's multi-statement assembly. Extremely rare in practice
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
 * Curried on `source` so each consumer's degradations report under its own
 * Sentry source tag: this module binds `'dashboard/service'` below; the
 * aggregate path (aggregate-service.ts) binds `'dashboard/aggregate'` and
 * passes `{ accountId }` context instead of `{ businessId }`.
 */
export function widgetOrFallbackFor(source: string) {
  return function widgetOrFallback<T>(
    result: PromiseSettledResult<T>,
    fallback: T,
    widget: string,
    context: Record<string, string>,
  ): T {
    if (result.status === 'fulfilled') return result.value;
    reportCaughtError(source, result.reason, {
      ...context,
      widget,
      degraded: true,
    });
    return fallback;
  };
}

const widgetOrFallback = widgetOrFallbackFor('dashboard/service');

export async function getActiveDashboardData(
  sql: Sql,
  businessId: string,
  opts?: ActiveDashboardOpts,
): Promise<DashboardDataActive> {
  const cacheKey = locationCacheKey(businessId, opts);
  return withTtlCache(
    cacheKey,
    DASHBOARD_LOCATION_CACHE_TTL_SECONDS,
    () => buildActiveDashboardData(sql, businessId, opts),
    'dashboard/service',
  );
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
  // for all 12 auxiliaries to settle (up to statement_timeout, 30s).
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
  // Business first, ALONE: it is the fatal identity read, so resolving it
  // before the wave means a missing business throws without dispatching 12
  // auxiliary queries. (It also removes the unhandled-rejection hazard the old
  // ordering had to work around by attaching handlers up front.)
  const businessRows = await businessPromise;
  const business = businessRows[0];
  if (!business) {
    throw new BusinessNotFoundError(businessId);
  }

  // SEQUENTIAL via settledInOrder — do NOT swap this back to Promise.allSettled
  // (#505). This wave is 12 members wide (10 sql + a Redis marker + the
  // 4-query reputation batch) on the SHARED `sql` client, whose pool is
  // `DB_POOL_MAX` = 3 on Vercel; /api/dashboard/route.ts passes that singleton,
  // not the larger `sqlRead`. Fan-out that far past the pool makes postgres.js
  // pipeline the excess onto already-open connections over the Supavisor
  // TRANSACTION pooler, where the response parks in state=active /
  // wait_event=ClientRead forever and leaks a pool slot per render. The settled
  // shape is preserved because each widget degrades independently below.
  //
  // Added latency lands only on a cache MISS (45s Redis TTL). The members are
  // now THUNKS: passing promises would dispatch them before settledInOrder saw
  // them, which is the concurrency being removed.
  //
  // Statement budget (service.statement-count.test.ts pins it): two former
  // members were folded into scans that already existed — the all-time review
  // total rides the rating-breakdown GROUP BY (same table, same rows), and
  // the reputation sentiment trend rides the velocity series (same table,
  // same anchor, same weeks). Each fold shares ONE failure domain: the total
  // degrades with the breakdown, and the trend — hence the whole reputation
  // summary — degrades with velocity. Do not fold across tables; the banner
  // trio and the two briefs stay separate on purpose.
  //
  // The weekly series is captured here so the reputation member (last, and
  // sequential) can reuse it instead of re-scanning the same weeks.
  let weeklySeriesRows: WeeklySeriesRow[] | null = null;
  const [
    reviewCountSettled,
    totalRespondedSettled,
    weeklySeriesSettled,
    rankingSettled,
    recentReviewSettled,
    monthlyBriefSettled,
    weeklyBriefSettled,
    zernioConnectionSettled,
    queuedReconnectSettled,
    unresolvedIncidentSettled,
    pendingSettled,
    reputationSettled,
  ] = await settledInOrder([
    // Review counts in ONE scan: `total_count` is the all-time total per star
    // bucket (summed below — the NULL-star group counts toward the total too),
    // `count` is the windowed 1–5★ breakdown (#405): true distribution across
    // the selected window — NOT the recentReviews sample. star_rating is
    // INTEGER CHECK (1..5) or NULL (migration 001), so a direct GROUP BY is
    // exact. The window reaches SQL only as a bound integer via make_interval
    // (issue #403); zero-fill + ordering happen in buildRatingBreakdown.
    () => sql<ReviewCountRow[]>`
      SELECT star_rating AS stars,
             COUNT(*)::int AS total_count,
             COUNT(*) FILTER (
               WHERE star_rating IS NOT NULL
                 AND ${reviewTimeWindowFilter(sql, '', windowDays)}
             )::int AS count
      FROM reviews
      WHERE business_id = ${businessId}
        AND status <> ${REVIEW_STATUS.DELETED}
      GROUP BY star_rating
    `,
    // Total responded (distinct reviews with non-superseded responses)
    () => sql<{ count: number }[]>`
      SELECT COUNT(DISTINCT r.id)::int AS count
      FROM reviews r
      JOIN responses resp ON resp.review_id = r.id
      WHERE r.business_id = ${businessId}
        AND r.status <> ${REVIEW_STATUS.DELETED}
        AND resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
    `,
    // Weekly series: last `trendWeeks` weeks (zero-filled), window-driven.
    // `count` is the review velocity; `avg_score` is the sentiment trend the
    // reputation batch renders (same rows, same weeks, one scan). Sentiment
    // trend semantics: AVG over the same reviews the velocity counts, NULL for
    // an empty week (the LEFT JOIN keeps the week; buildReputationSummary
    // treats NULL as "no data").
    async () => {
      const rows = await sql<WeeklySeriesRow[]>`
      SELECT gs::date AS week_start,
             COALESCE(r.cnt, 0)::int AS count,
             r.avg_score::float AS avg_score
      FROM generate_series(
        DATE_TRUNC('week', NOW() - make_interval(weeks => ${velocitySpanWeeks})),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN (
        SELECT DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})::date AS wk,
               COUNT(*) AS cnt,
               AVG(sentiment_score) AS avg_score
        FROM reviews
        WHERE business_id = ${businessId}
          AND ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(weeks => ${trendWeeks})
          AND status <> ${REVIEW_STATUS.DELETED}
        GROUP BY DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})
      ) r ON r.wk = gs::date
      ORDER BY week_start ASC
    `;
      weeklySeriesRows = rows;
      return rows;
    },
    // Ranking snapshots (all with rank_position)
    () => sql<DashboardRankingRow[]>`
      SELECT keyword, snapshot_date, rank_position
      FROM ranking_snapshots
      WHERE business_id = ${businessId}
        AND rank_position IS NOT NULL
        AND snapshot_date >= (CURRENT_DATE - INTERVAL '12 months')
      ORDER BY keyword ASC, snapshot_date ASC
    `,
    // Recent reviews: last 10 with latest non-superseded/failed response
    // Include pending_approval so the UI can show "check your email" reminders
    () => sql<Record<string, unknown>[]>`
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
          AND NOT ${openFlagExistsSql(sql, sql`responses.id`)}
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
    () => sql<DashboardBriefRow[]>`
      SELECT summary_text, month_start_date, sent_at
      FROM monthly_impact_emails
      WHERE business_id = ${businessId}
        AND summary_text IS NOT NULL
        AND sent_at IS NOT NULL
      ORDER BY sent_at DESC
      LIMIT 1
    `,
    // Latest weekly brief (with sent_at for recency comparison)
    () => sql<DashboardBriefRow[]>`
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
    () => sql<DashboardZernioConnectionRow[]>`
      SELECT status, disconnect_reason
      FROM zernio_connections
      WHERE business_id = ${businessId}
      ORDER BY created_at DESC
      LIMIT 1
    `,
    // Queued-for-reconnect responses: approved drafts parked while Zernio is
    // disconnected. Drives banner headline copy ("3 responses are waiting...").
    () => sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM responses
      WHERE business_id = ${businessId}
        AND status = 'awaiting_owner_connect'
    `,
    // Unresolved finalize incident: takes priority over the connection status —
    // owner sees "manual review" banner regardless of zernio_connections state.
    () => sql<{ count: number }[]>`
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
    () => readPendingMarker(businessId),
    // Opt-in reputation batch (single-location landing only), fetched in the
    // SAME sequential wave as the main batch — running it afterwards cost a
    // full extra pool round-trip wave per landing request. Aggregate/connect
    // callers omit the flag and pay nothing. The sentiment trend comes from
    // the weekly series above; if that member failed, the whole reputation
    // summary degrades with it (one failure domain, see the wave comment).
    async () => {
      if (!opts?.includeReputationMetrics) return null;
      if (!weeklySeriesRows) {
        throw new Error('reputation batch skipped: weekly series unavailable');
      }
      return fetchReputationRows(sql, businessId, windowDays, weeklySeriesRows);
    },
  ]);

  // Fallbacks are typed (not bare []) so T infers as the plain row-array
  // type rather than Postgres.js's RowList intersection.
  const reviewCountRows = widgetOrFallback(reviewCountSettled, [] as ReviewCountRow[], 'reviewCountRows', { businessId });
  const totalRespondedRows = widgetOrFallback(totalRespondedSettled, [] as { count: number }[], 'totalRespondedRows', { businessId });
  const velocityRows = widgetOrFallback(weeklySeriesSettled, [] as WeeklySeriesRow[], 'velocityRows', { businessId });
  const rankingRows = widgetOrFallback(rankingSettled, [] as DashboardRankingRow[], 'rankingRows', { businessId });
  const recentReviewRows = widgetOrFallback(recentReviewSettled, [] as Record<string, unknown>[], 'recentReviewRows', { businessId });
  const monthlyBriefRows = widgetOrFallback(monthlyBriefSettled, [] as DashboardBriefRow[], 'monthlyBriefRows', { businessId });
  const weeklyBriefRows = widgetOrFallback(weeklyBriefSettled, [] as DashboardBriefRow[], 'weeklyBriefRows', { businessId });
  const zernioConnectionRows = widgetOrFallback(zernioConnectionSettled, [] as DashboardZernioConnectionRow[], 'zernioConnectionRows', { businessId });
  const queuedReconnectRows = widgetOrFallback(queuedReconnectSettled, [] as { count: number }[], 'queuedReconnectRows', { businessId });
  const unresolvedIncidentRows = widgetOrFallback(unresolvedIncidentSettled, [] as { count: number }[], 'unresolvedIncidentRows', { businessId });
  const pendingRaw = widgetOrFallback(pendingSettled, null, 'pendingRaw', { businessId });
  // Reputation degrades as ONE widget: fetchReputationRows batches its five
  // queries internally, so any failure inside nulls the whole summary.
  const reputationRows = widgetOrFallback(reputationSettled, null, 'reputationRows', { businessId });

  // One scan feeds both: the all-time total sums EVERY group (unrated reviews
  // included), the breakdown keeps only the rated groups' windowed counts.
  const totalReviews = reviewCountRows.reduce((sum, row) => sum + Number(row.total_count ?? 0), 0);
  const ratingBreakdownRows = reviewCountRows
    .filter((row) => row.stars != null)
    .map((row) => ({ stars: Number(row.stars), count: Number(row.count ?? 0) }));
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
 * FILTER (single round-trip per metric), plus the authoritative
 * pending-approval count. The `trendWeeks`-week sentiment trend is NOT queried
 * here: it is the `avg_score` column of the weekly series the main wave already
 * fetched (same reviews, same anchor, same weeks), passed in as `weeklySeries`.
 * Response-rate history uses `approved_at <= prior window end` so late
 * approvals don't retro-inflate the prior period (PLAN.md A.2). All scoped by
 * business_id. Intervals are PARAMETERIZED (issue #403): `windowDays` /
 * `priorEndDays` (= 2×windowDays) reach SQL only as bound integers via
 * make_interval(...).
 *
 * Avg star and the sentiment trend bucket on the Review-time anchor (ADR 0019,
 * #757); response rate stays on detected_at (workflow KPI) and timeSaved keys
 * on approved_at (action timestamp) — neither may be re-anchored. Rate and
 * star are deliberately separate statements even though both scan `reviews`:
 * service.review-time-anchor.test.ts pins that the rate query never spells the
 * anchor and the star query never spells a bare detected_at, a per-statement
 * guarantee a merged statement cannot give.
 */
async function fetchReputationRows(
  sql: Sql,
  businessId: string,
  windowDays: number,
  weeklySeries: readonly WeeklySeriesRow[],
): Promise<{
  rate: RateWindowRow;
  star: StarWindowRow;
  timeSaved: TimeSavedWindowRow;
  trend: SentimentTrendRow[];
  pendingApprovalCount: number;
}> {
  const priorEndDays = windowDays * 2;
  // SEQUENTIAL, one query in flight at a time — do NOT re-introduce a Promise.all
  // here (#505). This is a 4-query fan-out on the SHARED `sql` client, whose pool
  // is `DB_POOL_MAX` = 3 on Vercel (src/lib/db/server.ts) — /api/dashboard/route.ts
  // passes that singleton, not the larger `sqlRead`. Fan-out (4) > pool (3) makes
  // postgres.js pipeline the excess queries onto already-open connections over the
  // Supabase Supavisor TRANSACTION pooler; a pipelined query's response parks
  // server-side in state=active / wait_event=ClientRead and is never read — a
  // PERMANENT Connection wedge that leaks one pool slot per render and no
  // server-side timeout can heal (in ClientRead the statement is not executing, so
  // `statement_timeout` never fires). The same defect took the admin portal down
  // on staging 2026-08-10; this is the owner-facing instance of it.
  //
  // The added latency lands only on a cache MISS — buildActiveDashboardData is
  // Redis-cached at DASHBOARD_LOCATION_CACHE_TTL_SECONDS (45s).
  const rateRows = await sql<RateWindowRow[]>`
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
  `;
  const starRows = await sql<StarWindowRow[]>`
        SELECT
          -- Single-sided current window: the canonical helper. The prior-window
          -- pairs below are two-sided, which no fragment models, so they compose
          -- the anchor directly.
          AVG(star_rating) FILTER (
            WHERE ${reviewTimeWindowFilter(sql, '', windowDays)}
          )::float AS star_current,
          COUNT(star_rating) FILTER (
            WHERE ${reviewTimeWindowFilter(sql, '', windowDays)}
          )::int AS star_n_current,
          AVG(star_rating) FILTER (
            WHERE ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(days => ${priorEndDays})
              AND ${reviewTimeAnchor(sql, '')} < NOW() - make_interval(days => ${windowDays})
          )::float AS star_prior,
          COUNT(star_rating) FILTER (
            WHERE ${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(days => ${priorEndDays})
              AND ${reviewTimeAnchor(sql, '')} < NOW() - make_interval(days => ${windowDays})
          )::int AS star_n_prior
        FROM reviews
        WHERE business_id = ${businessId}
          AND status <> ${REVIEW_STATUS.DELETED}
          AND star_rating IS NOT NULL
          AND ${reviewTimeWindowFilter(sql, '', priorEndDays)}
  `;
  const timeSavedRows = await sql<TimeSavedWindowRow[]>`
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
  `;
  const trendRows: SentimentTrendRow[] = weeklySeries.map((row) => ({
    week_start: row.week_start,
    avg_score: row.avg_score,
    cnt: row.count,
  }));
  const pendingApprovalCount = await getPendingApprovalCount(sql, businessId);

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
