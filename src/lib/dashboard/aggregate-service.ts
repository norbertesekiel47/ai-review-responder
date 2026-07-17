// src/lib/dashboard/aggregate-service.ts
//
// Builds AggregateDashboardData for the "All Locations" aggregate view.
// Called by the /api/dashboard?scope=all route handler.
//
// Strategy: a single set-based per-account aggregate wave
// (`fetchPerLocationAggregateSlices`) reproduces — per location — exactly the
// subset of the per-location dashboard batch this view consumes, fed through
// the same per-location mappers so the retained fields are identical by
// construction. This replaces the former per-location fan-out (~14 queries × N
// via mapWithConcurrency); the query count is now independent of N.

import type { Sql } from 'postgres';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { RECENT_REVIEW_DISPLAY_STATUSES } from '@/lib/shared/response-status';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import {
  type DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
} from '@/lib/kpi/types';
import { mapRecentReviews } from './active-mappers';
import { widgetOrFallback } from './service';
import { sumRatingBreakdowns } from './rating-breakdown';
import {
  fetchPerLocationAggregateSlices,
  type PerLocationAggregateSlice,
} from './aggregate-queries';
import { getLocationsForAccount } from '@/lib/locations/repo';
import { getDisplayLabel } from '@/lib/locations/display-label';
import type {
  AggregateDashboardData,
  AggregateReviewItem,
  PerLocationKpi,
  PerLocationVelocity,
  PerLocationRanking,
  PerLocationBrief,
} from './types';

// Zero-filled slice for the defensive case where a location returned by
// getLocationsForAccount has no row in the aggregate wave (both derive from the
// same active-businesses set, so this is unreachable in practice).
const EMPTY_SLICE: PerLocationAggregateSlice = {
  valueSummary: {
    totalReviewsHandled: 0,
    totalTimeSavedMinutes: 0,
    currentResponseRate: 0,
    baselineResponseRate: null,
  },
  reviewVelocity: [],
  ranking: null,
  ratingBreakdown: sumRatingBreakdowns([]),
  latestBrief: null,
  recentReviewCount: 0,
  pendingApprovalCount: 0,
  windowedReceived: 0,
  windowedResponded: 0,
};

// Short TTL cache for the aggregate payload. Repeated loads within the TTL — tab
// switches, the KPI poll, several owners of the same account — reuse one
// computation. 45s staleness is invisible next to the pipeline's own
// multi-second latency. The aggregate is now atomic (one wave, no partial
// failures), so the payload is always cacheable.
const AGGREGATE_CACHE_TTL_SECONDS = 45;

function aggregateCacheKey(accountId: string, window: DashboardWindow): string {
  return `dashboard:aggregate:${accountId}:${window}`;
}

/**
 * Builds aggregate dashboard data for all active locations in an account.
 *
 * The function:
 * 1. Fetches all active locations for the account
 * 2. Runs the set-based per-account aggregate (`fetchPerLocationAggregateSlices`) —
 *    one fixed wave of `GROUP BY business_id` queries, count independent of N
 * 3. Computes aggregate sums across locations
 * 4. Builds per-location breakdown data (KPI strip, velocity, ranking, reviews, briefs)
 *
 * Performance: the query count does NOT scale with location count — the slices
 * come from a fixed set-based wave, bucketed by `business_id` and fed through the
 * per-location mappers, so the retained output is byte-identical to the old
 * per-location fan-out (~14 queries × N via mapWithConcurrency) it replaced (#476).
 */
export async function getAggregateDashboardData(
  sql: Sql,
  accountId: string,
  window: DashboardWindow = DEFAULT_DASHBOARD_WINDOW,
): Promise<AggregateDashboardData> {
  // Cache read fails open: a Redis blip degrades to a fresh computation.
  const cacheKey = aggregateCacheKey(accountId, window);
  try {
    const cached = await getCacheRedis().get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as AggregateDashboardData;
    }
  } catch (err) {
    console.error('[dashboard/aggregate] cache read failed (computing fresh):', err);
  }

  const data = await buildAggregateDashboardData(sql, accountId, window);

  // The aggregate is atomic now (a single set-based wave), so the payload is
  // always safe to cache — no partial-failure gate.
  try {
    await getCacheRedis().set(cacheKey, JSON.stringify(data), 'EX', AGGREGATE_CACHE_TTL_SECONDS);
  } catch (err) {
    console.error('[dashboard/aggregate] cache write failed (serving fresh):', err);
  }

  return data;
}

async function buildAggregateDashboardData(
  sql: Sql,
  accountId: string,
  window: DashboardWindow,
): Promise<AggregateDashboardData> {
  // P10 (plan R2): the locations-list query stays FATAL — an aggregate over
  // unknown locations is meaningless (the analog of the business lookup in
  // getActiveDashboardData). The billing query degrades: its `??` defaults
  // below already render a sane KPI strip without it.
  const locationsPromise = getLocationsForAccount(sql, accountId);
  const accountSettledPromise = Promise.allSettled([
    // VAL-DASH-028: Fetch account billing data to determine billingPending flag.
    // A location's KPI shows "Billing update pending" when the Stripe overage
    // webhook has not yet confirmed the quantity update (i.e., the active
    // location count exceeds locations_included + locations_paid).
    sql<{
      locations_included: number;
      locations_paid: number;
    }[]>`
      SELECT locations_included, locations_paid
      FROM accounts WHERE id = ${accountId}::uuid
    `,
  ]);
  const locations = await locationsPromise;
  const [accountRowsSettled] = await accountSettledPromise;
  const accountRows = widgetOrFallback(
    accountRowsSettled,
    [] as { locations_included: number; locations_paid: number }[],
    'accountBillingRows',
    { accountId },
  );
  const [accountRow] = accountRows;
  const locationsIncluded = accountRow?.locations_included ?? 1;
  const locationsPaid = accountRow?.locations_paid ?? 0;
  const billingConfirmedCount = locationsIncluded + locationsPaid;

  if (locations.length === 0) {
    // Edge case: account with no active locations
    return {
      scope: 'aggregate',
      valueSummary: {
        totalReviewsHandled: 0,
        totalTimeSavedMinutes: 0,
        currentResponseRate: 0,
        baselineResponseRate: null,
      },
      ratingBreakdown: sumRatingBreakdowns([]),
      reviewVelocity: [],
      perLocationVelocity: [],
      ranking: null,
      perLocationRanking: [],
      recentReviews: [],
      perLocationBriefs: [],
      locationKpis: [],
      activeLocationCount: 0,
    };
  }

  // One set-based aggregate wave (constant query count) + the account-wide
  // LIMIT-20 recent-reviews feed, run together. Every retained field is then
  // assembled from the per-location slices exactly as before — only the fetch
  // layer changed, so the output is byte-identical (bar the two signed-off
  // deltas: windowed currentResponseRate, and partialFailures removed).
  // P10 on the #476 set-based shape: the slice wave is atomic — it IS the
  // aggregate view (every widget derives from it), so like the locations list
  // it stays FATAL; degrading it to empty slices would render an all-zeros
  // dashboard that misreports the business. The account-wide recent-reviews
  // feed is an independent widget and degrades to an empty feed, reported.
  const slicesPromise = fetchPerLocationAggregateSlices(sql, accountId, window);
  const recentReviewsSettledPromise = Promise.allSettled([
    getAccountRecentReviews(sql, accountId),
  ]);
  const slices = await slicesPromise;
  const [recentReviewsSettled] = await recentReviewsSettledPromise;
  const recentReviews = widgetOrFallback(
    recentReviewsSettled,
    [] as AggregateReviewItem[],
    'accountRecentReviews',
    { accountId },
  );

  const sliceFor = (locationId: string): PerLocationAggregateSlice =>
    slices.get(locationId) ?? EMPTY_SLICE;

  // ── Aggregate Value Summary ──────────────────────────────────────────────
  let totalReviewsHandled = 0;
  let totalTimeSavedMinutes = 0;
  let windowedReceived = 0;
  let windowedResponded = 0;
  for (const loc of locations) {
    const slice = sliceFor(loc.id);
    totalReviewsHandled += slice.valueSummary.totalReviewsHandled;
    totalTimeSavedMinutes += slice.valueSummary.totalTimeSavedMinutes;
    windowedReceived += slice.windowedReceived;
    windowedResponded += slice.windowedResponded;
  }

  // Windowed account response rate (signed-off delta #476): the account's
  // handled/received counts over the selected window — a change from the old
  // ALL-TIME account rate. Summing the per-location windowed counts equals a
  // single account-wide windowed COUNT because locations partition reviews by
  // business_id.
  const currentResponseRate =
    windowedReceived > 0
      ? Math.round((windowedResponded / windowedReceived) * 100)
      : 0;

  // Baseline: use the primary location's baseline if available
  const primaryLocation = locations.find((loc) => loc.is_primary);
  const baselineResponseRate = primaryLocation
    ? sliceFor(primaryLocation.id).valueSummary.baselineResponseRate
    : null;

  // ── Per-Location KPIs (strip) ────────────────────────────────────────────
  // VAL-DASH-028: billingPending is true for locations whose index exceeds
  // the billing-confirmed count (locations_included + locations_paid).
  // pendingApprovalCount is the authoritative SQL count (no LIMIT, held/flagged
  // excluded) — NOT a filter over the capped recentReviews slice, which
  // undercounts >10 pending (#346). recentReviewCount stays the displayed
  // slice size (LEAST(all-time, 10)).
  const locationKpis: PerLocationKpi[] = locations.map((loc, idx) => {
    const slice = sliceFor(loc.id);
    return {
      locationId: loc.id,
      displayName: getDisplayLabel(loc),
      isPrimary: loc.is_primary,
      totalReviewsHandled: slice.valueSummary.totalReviewsHandled,
      pendingApprovalCount: slice.pendingApprovalCount,
      recentReviewCount: slice.recentReviewCount,
      billingPending: idx >= billingConfirmedCount,
    };
  });

  // ── Review Velocity (combined total + per-location) ──────────────────────
  // Merge all week keys across locations, sum counts per week
  const weekMap = new Map<string, number>();
  const perLocationVelocity: PerLocationVelocity[] = [];

  for (const loc of locations) {
    const slice = sliceFor(loc.id);
    perLocationVelocity.push({
      locationId: loc.id,
      displayName: getDisplayLabel(loc),
      velocity: slice.reviewVelocity,
    });
    for (const v of slice.reviewVelocity) {
      weekMap.set(v.weekStart, (weekMap.get(v.weekStart) ?? 0) + v.count);
    }
  }

  const reviewVelocity = Array.from(weekMap.entries())
    .map(([weekStart, count]) => ({ weekStart, count }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  // ── Ranking (best position across locations per keyword) ─────────────────
  const perLocationRanking: PerLocationRanking[] = [];

  // Build a unified ranking map: for each keyword, take the best (lowest)
  // position across all locations for each date
  const keywordMap = new Map<
    string,
    Map<string, number>
  >(); // keyword → date → bestPosition

  for (const loc of locations) {
    const locationRanking = sliceFor(loc.id).ranking;
    if (locationRanking) {
      perLocationRanking.push({
        locationId: loc.id,
        displayName: getDisplayLabel(loc),
        ranking: locationRanking,
      });

      for (const kw of locationRanking) {
        if (!keywordMap.has(kw.keyword)) {
          keywordMap.set(kw.keyword, new Map());
        }
        const dateMap = keywordMap.get(kw.keyword)!;
        for (const s of kw.snapshots) {
          const existing = dateMap.get(s.date);
          if (existing === undefined || s.position < existing) {
            dateMap.set(s.date, s.position);
          }
        }
      }
    }
  }

  const ranking =
    keywordMap.size > 0
      ? Array.from(keywordMap.entries()).map(([keyword, dateMap]) => ({
          keyword,
          snapshots: Array.from(dateMap.entries())
            .map(([date, position]) => ({ date, position }))
            .sort((a, b) => a.date.localeCompare(b.date)),
        }))
      : null;

  // ── Reviews by rating (#405) ─────────────────────────────────────────────
  // Sum the per-location windowed 1–5★ breakdowns. Each location's breakdown is
  // scoped by business_id and the locations are scoped by account_id, so the
  // account-wide rollup leaks no other tenant.
  const ratingBreakdown = sumRatingBreakdowns(
    locations.map((loc) => sliceFor(loc.id).ratingBreakdown),
  );

  // ── Per-Location Briefs ─────────────────────────────────────────────────
  const perLocationBriefs: PerLocationBrief[] = locations
    .map((loc) => ({ loc, brief: sliceFor(loc.id).latestBrief }))
    .filter((entry) => entry.brief !== null)
    .map((entry) => ({
      locationId: entry.loc.id,
      displayName: getDisplayLabel(entry.loc),
      brief: entry.brief,
    }));

  return {
    scope: 'aggregate',
    valueSummary: {
      totalReviewsHandled,
      totalTimeSavedMinutes,
      currentResponseRate,
      baselineResponseRate,
    },
    ratingBreakdown,
    reviewVelocity,
    perLocationVelocity,
    ranking,
    perLocationRanking,
    recentReviews,
    perLocationBriefs,
    locationKpis,
    activeLocationCount: locations.length,
  };
}

// ── Account-wide recent reviews (combined feed) ─────────────────────────────

/**
 * The 20 most recently detected reviews across ALL active locations of the
 * account, with each row's latest displayable response and open escalation —
 * the account-wide twin of the per-location recentReviews query in
 * service.ts (same LATERAL joins, same held-for-review exclusion), plus the
 * location chip columns. Sorted for display by reviewDate (matching the old
 * composed feed's presentation order).
 */
async function getAccountRecentReviews(
  sql: Sql,
  accountId: string,
): Promise<AggregateReviewItem[]> {
  const rows = await sql<Record<string, unknown>[]>`
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
      esc.triage_severity AS escalation_severity,
      b.id AS location_id,
      b.name AS location_name,
      b.display_label AS location_display_label
    FROM reviews rev
    JOIN businesses b ON b.id = rev.business_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at
      FROM responses
      WHERE review_id = rev.id
        -- Explicit tenant scope: responses belong to the same location as the
        -- review (defense-in-depth alongside the review_id correlation).
        AND business_id = rev.business_id
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
        AND e.business_id = rev.business_id
        -- Status literal kept deliberately: it matches the
        -- review_escalations_one_open_per_review partial-index predicate
        -- byte-for-byte so the planner can use that index.
        AND e.status <> 'resolved'
      LIMIT 1
    ) esc ON true
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND rev.status <> ${REVIEW_STATUS.DELETED}
    ORDER BY rev.detected_at DESC
    LIMIT 20
  `;

  const base = mapRecentReviews(rows);
  const items = base.map((item, index) => ({
    ...item,
    locationId: rows[index]!.location_id as string,
    locationDisplayName: getDisplayLabel({
      name: rows[index]!.location_name as string,
      display_label: (rows[index]!.location_display_label as string | null) ?? null,
    }),
  }));
  // Selection is by detected_at (recency of ingestion); presentation stays
  // ordered by the review's own date, matching the previous composed feed.
  items.sort((a, b) => b.reviewDate.localeCompare(a.reviewDate));
  return items;
}
