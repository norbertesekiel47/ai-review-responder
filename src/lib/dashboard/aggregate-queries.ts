// src/lib/dashboard/aggregate-queries.ts
//
// Set-based per-account aggregate: a fixed wave of `GROUP BY business_id`
// queries (count independent of the number of locations N) that reproduces —
// per location — exactly the subset of the per-location dashboard batch the
// All-Locations view consumes. Rows are bucketed by `business_id` and fed
// through the SAME per-location mappers the single-location owner (service.ts)
// uses, so the retained output is identical by construction. This replaces the
// old per-location fan-out (~14 queries × N via mapWithConcurrency).
//
// Domain module (invariant #15): `sql` is an explicit parameter; this file
// never imports `@/lib/db/server`.

import type { Sql } from 'postgres';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import { settledInOrder } from '@/lib/shared/settled-in-order';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import {
  type DashboardWindow,
  dashboardWindowParams,
} from '@/lib/kpi/types';
import {
  buildValueSummary,
  buildRanking,
  selectLatestBrief,
  type DashboardBusinessRow,
  type DashboardRankingRow,
  type DashboardBriefRow,
} from './service-mappers';
import { mapReviewVelocity } from './active-mappers';
import { buildRatingBreakdown } from './rating-breakdown';
import { getPendingApprovalCountsForAccount } from './pending-count';
import { widgetOrFallbackFor } from './service';
import type { DashboardDataActive, RatingBreakdown, ValueSummary } from './types';

// Wave degradations report under the aggregate path's source tag, matching
// aggregate-service.ts (which owns the other 'dashboard/aggregate' widgets).
const widgetOrFallback = widgetOrFallbackFor('dashboard/aggregate');

const HANDLED = [...HANDLED_STATUSES] as string[];

/** Cap on the per-location recent-reviews slice — mirrors service.ts LIMIT 10. */
const RECENT_REVIEW_SLICE_CAP = 10;

/**
 * Everything the aggregate view needs from ONE location, reproduced from the
 * set-based wave and fed through the existing per-location mappers so each
 * field is byte-identical to what `getActiveDashboardData` would have returned.
 */
export interface PerLocationAggregateSlice {
  valueSummary: ValueSummary;
  reviewVelocity: DashboardDataActive['reviewVelocity'];
  ranking: DashboardDataActive['ranking'];
  ratingBreakdown: RatingBreakdown;
  latestBrief: DashboardDataActive['latestBrief'];
  /** LEAST(all-time non-deleted review count, 10) — the size of the capped feed slice. */
  recentReviewCount: number;
  /** Authoritative owner-drafts-awaiting-approval count (excludes held/flagged). */
  pendingApprovalCount: number;
  /** Non-deleted reviews with detected_at in the window. */
  windowedReceived: number;
  /** Distinct such reviews carrying a HANDLED response. */
  windowedResponded: number;
}

// ── Row shapes returned by the set-based wave ───────────────────────────────

interface BaselineRow {
  business_id: string;
  name: string;
  created_at: Date;
  initial_review_count: number | null;
  initial_responded_count: number | null;
  baseline_captured_at: Date | string | null;
}

interface CounterRow {
  business_id: string;
  total_received_all_time: number;
  total_responded_all_time: number;
  received_window: number;
  responded_window: number;
}

interface VelocityRow {
  business_id: string;
  week_start: unknown;
  count: number;
}

interface RatingRow {
  business_id: string;
  stars: number;
  count: number;
}

interface RankingRow extends DashboardRankingRow {
  business_id: string;
}

interface MonthlyBriefRow extends DashboardBriefRow {
  business_id: string;
}

interface WeeklyBriefRow extends DashboardBriefRow {
  business_id: string;
}

/**
 * Set-based per-account aggregate. Returns one {@link PerLocationAggregateSlice}
 * per active location, keyed by `business_id`. The query count is fixed (does
 * not grow with N): six grouped statements in one wave, plus the account-wide
 * pending-count rollup.
 *
 * Degradation contract (P10, adversarial finding 2): the wave is NOT atomic —
 * its reads settle independently, and each one degrades per-query via
 * `widgetOrFallback` (reported, never silent), emptying that widget's column
 * across locations instead of failing the whole aggregate. Only the baseline
 * read stays FATAL: it is the identity anchor the slices are built from
 * (iterating its rows), so degrading it would return an all-zeros aggregate
 * that misreports the business — the in-wave analog of the fatal
 * locations-list query in aggregate-service.ts.
 */
export async function fetchPerLocationAggregateSlices(
  sql: Sql,
  accountId: string,
  window: DashboardWindow,
): Promise<Map<string, PerLocationAggregateSlice>> {
  const { windowDays, trendWeeks } = dashboardWindowParams(window);
  const velocitySpanWeeks = trendWeeks - 1;

  // SEQUENTIAL via settledInOrder — do NOT swap this back to Promise.allSettled
  // (#505). See that helper's doc comment for the wedge mechanism and why the
  // settled shape is preserved rather than becoming plain awaits.
  const [
    baselineSettled,
    countersSettled,
    velocitySettled,
    ratingSettled,
    rankingSettled,
    monthlySettled,
    weeklySettled,
    pendingSettled,
  ] = await settledInOrder([
    // (6) Baseline columns — the anchor set of active locations. buildValueSummary
    //     reads baseline_captured_at / initial_review_count / initial_responded_count.
    () => sql<BaselineRow[]>`
      SELECT id AS business_id, name, created_at,
             initial_review_count, initial_responded_count, baseline_captured_at
      FROM businesses
      WHERE account_id = ${accountId}::uuid
        AND archived_at IS NULL
    `,
    // (1) Review counters — GROUP BY b.id, LEFT JOINs so zero-review locations
    //     still return a row. `responses` is joined in the MAIN query (correlated
    //     to the account-scoped businesses row) rather than a per-count EXISTS
    //     subquery, so its tenant scope is statically provable; COUNT(DISTINCT
    //     r.id) then makes the received/responded counts robust to a review with
    //     multiple handled responses (the response fan-out).
    () => sql<CounterRow[]>`
      SELECT
        b.id AS business_id,
        COUNT(DISTINCT r.id)::int AS total_received_all_time,
        COUNT(DISTINCT r.id) FILTER (
          WHERE resp.id IS NOT NULL
        )::int AS total_responded_all_time,
        COUNT(DISTINCT r.id) FILTER (
          WHERE r.detected_at >= NOW() - make_interval(days => ${windowDays})
        )::int AS received_window,
        COUNT(DISTINCT r.id) FILTER (
          WHERE r.detected_at >= NOW() - make_interval(days => ${windowDays})
            AND resp.id IS NOT NULL
        )::int AS responded_window
      FROM businesses b
      LEFT JOIN reviews r
        ON r.business_id = b.id
        AND r.status <> ${REVIEW_STATUS.DELETED}
      LEFT JOIN responses resp
        ON resp.review_id = r.id
        AND resp.business_id = b.id
        AND resp.status = ANY(${HANDLED}::text[])
      WHERE b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
      GROUP BY b.id
    `,
    // (2) Velocity — windowed weekly counts, zero-filled per location via
    //     businesses × generate_series. `reviews` is joined in the MAIN query
    //     (correlated to the account-scoped businesses row) and bucketed by
    //     week directly, so its tenant scope is statically provable; a review
    //     matches exactly one gs week, so a plain COUNT is exact.
    () => sql<VelocityRow[]>`
      SELECT b.id AS business_id, gs::date AS week_start, COUNT(rv.id)::int AS count
      FROM businesses b
      CROSS JOIN generate_series(
        DATE_TRUNC('week', NOW() - make_interval(weeks => ${velocitySpanWeeks})),
        DATE_TRUNC('week', NOW()),
        INTERVAL '1 week'
      ) gs
      LEFT JOIN reviews rv
        ON rv.business_id = b.id
        AND rv.status <> ${REVIEW_STATUS.DELETED}
        AND rv.detected_at >= NOW() - make_interval(weeks => ${trendWeeks})
        AND DATE_TRUNC('week', rv.detected_at)::date = gs::date
      WHERE b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
      GROUP BY b.id, gs::date
      ORDER BY b.id, week_start ASC
    `,
    // (3) Rating breakdown — windowed GROUP BY b.id, star_rating.
    () => sql<RatingRow[]>`
      SELECT b.id AS business_id, rev.star_rating AS stars, COUNT(*)::int AS count
      FROM businesses b
      JOIN reviews rev ON rev.business_id = b.id
      WHERE b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
        AND rev.status <> ${REVIEW_STATUS.DELETED}
        AND rev.star_rating IS NOT NULL
        AND rev.detected_at >= NOW() - make_interval(days => ${windowDays})
      GROUP BY b.id, rev.star_rating
    `,
    // (4) Ranking — last 12 months, ordered so buildRanking's per-keyword
    //     snapshot arrays come out chronological.
    () => sql<RankingRow[]>`
      SELECT b.id AS business_id, rs.keyword, rs.snapshot_date, rs.rank_position
      FROM businesses b
      JOIN ranking_snapshots rs ON rs.business_id = b.id
      WHERE b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
        AND rs.rank_position IS NOT NULL
        AND rs.snapshot_date >= (CURRENT_DATE - INTERVAL '12 months')
      ORDER BY b.id, rs.keyword ASC, rs.snapshot_date ASC
    `,
    // (5a) Latest monthly brief per location (DISTINCT ON).
    () => sql<MonthlyBriefRow[]>`
      SELECT DISTINCT ON (b.id)
        b.id AS business_id, m.summary_text, m.month_start_date, m.sent_at
      FROM businesses b
      JOIN monthly_impact_emails m ON m.business_id = b.id
      WHERE b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
        AND m.summary_text IS NOT NULL
        AND m.sent_at IS NOT NULL
      ORDER BY b.id, m.sent_at DESC
    `,
    // (5b) Latest weekly brief per location (DISTINCT ON).
    () => sql<WeeklyBriefRow[]>`
      SELECT DISTINCT ON (b.id)
        b.id AS business_id, w.summary_text, w.week_start_date, w.sent_at
      FROM businesses b
      JOIN weekly_summaries w ON w.business_id = b.id
      WHERE b.account_id = ${accountId}::uuid
        AND b.archived_at IS NULL
        AND w.summary_text IS NOT NULL
        AND w.sent_at IS NOT NULL
      ORDER BY b.id, w.sent_at DESC
    `,
    // (7) Authoritative per-location pending-approval counts (excludes held/flagged).
    () => getPendingApprovalCountsForAccount(sql, accountId),
  ]);

  // FATAL identity anchor (see the degradation contract above).
  if (baselineSettled.status === 'rejected') throw baselineSettled.reason;
  const baselineRows = baselineSettled.value;

  const counterRows = widgetOrFallback(countersSettled, [] as CounterRow[], 'sliceReviewCounters', { accountId });
  const velocityRows = widgetOrFallback(velocitySettled, [] as VelocityRow[], 'sliceReviewVelocity', { accountId });
  const ratingRows = widgetOrFallback(ratingSettled, [] as RatingRow[], 'sliceRatingBreakdown', { accountId });
  const rankingRows = widgetOrFallback(rankingSettled, [] as RankingRow[], 'sliceRanking', { accountId });
  const monthlyRows = widgetOrFallback(monthlySettled, [] as MonthlyBriefRow[], 'sliceMonthlyBriefs', { accountId });
  const weeklyRows = widgetOrFallback(weeklySettled, [] as WeeklyBriefRow[], 'sliceWeeklyBriefs', { accountId });
  const pendingCounts = widgetOrFallback(pendingSettled, new Map<string, number>(), 'slicePendingApprovalCounts', { accountId });

  const countersById = new Map<string, CounterRow>();
  for (const row of counterRows) countersById.set(row.business_id, row);

  const velocityById = bucketBy(velocityRows, (r) => r.business_id);
  const ratingById = bucketBy(ratingRows, (r) => r.business_id);
  const rankingById = bucketBy(rankingRows, (r) => r.business_id);

  const monthlyById = new Map<string, MonthlyBriefRow>();
  for (const row of monthlyRows) monthlyById.set(row.business_id, row);
  const weeklyById = new Map<string, WeeklyBriefRow>();
  for (const row of weeklyRows) weeklyById.set(row.business_id, row);

  const slices = new Map<string, PerLocationAggregateSlice>();
  for (const baseline of baselineRows) {
    const id = baseline.business_id;
    const counters = countersById.get(id);
    const totalReceived = counters?.total_received_all_time ?? 0;
    const totalResponded = counters?.total_responded_all_time ?? 0;
    const windowedReceived = counters?.received_window ?? 0;
    const windowedResponded = counters?.responded_window ?? 0;

    slices.set(id, {
      valueSummary: buildValueSummary(
        totalReceived,
        totalResponded,
        toBusinessRow(baseline),
      ),
      reviewVelocity: mapReviewVelocity(velocityById.get(id) ?? []),
      ranking: buildRanking(rankingById.get(id) ?? []),
      ratingBreakdown: buildRatingBreakdown(ratingById.get(id) ?? []),
      latestBrief: selectLatestBrief(monthlyById.get(id), weeklyById.get(id)),
      recentReviewCount: Math.min(totalReceived, RECENT_REVIEW_SLICE_CAP),
      pendingApprovalCount: pendingCounts.get(id) ?? 0,
      windowedReceived,
      windowedResponded,
    });
  }

  return slices;
}

function bucketBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }
  return buckets;
}

/**
 * Adapt the baseline projection to the {@link DashboardBusinessRow} shape
 * `buildValueSummary` expects. Only the three baseline columns (plus name /
 * created_at) are read; the settings columns are irrelevant to the value
 * summary and stay null.
 */
function toBusinessRow(baseline: BaselineRow): DashboardBusinessRow {
  return {
    name: baseline.name,
    created_at: baseline.created_at,
    initial_review_count: baseline.initial_review_count,
    initial_responded_count: baseline.initial_responded_count,
    baseline_captured_at: baseline.baseline_captured_at,
    tone: null,
    products_services: null,
    avoid_facts: null,
    sample_responses: null,
    owner_phone: null,
    owner_email: null,
    weekly_summary_enabled: null,
    monthly_impact_enabled: null,
    category: null,
    google_place_id: null,
  };
}
