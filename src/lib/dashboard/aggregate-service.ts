// src/lib/dashboard/aggregate-service.ts
//
// Builds AggregateDashboardData for the "All Locations" aggregate view.
// Called by the /api/dashboard?scope=all route handler.
//
// Strategy: fetch per-location dashboard data for every active location
// in the account, then compute aggregate sums and per-location breakdowns.
// This approach reuses the existing getActiveDashboardData per-location
// query logic and composes results at the service layer rather than
// writing N+1-style aggregate SQL.

import type { Sql } from 'postgres';
import { getCacheRedis } from '@/lib/db/redis-cache';
import {
  HANDLED_STATUSES,
  RECENT_REVIEW_DISPLAY_STATUSES,
} from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import {
  type DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
} from '@/lib/kpi/types';
import { getActiveDashboardData } from './service';
import { mapRecentReviews } from './active-mappers';
import { sumRatingBreakdowns } from './rating-breakdown';
import { getPendingApprovalCount } from './pending-count';
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
import type { DashboardDataActive } from './types';

const AGGREGATE_LOCATION_CONCURRENCY = 5;

// Short TTL cache for the aggregate payload. This is the ONLY request path
// whose cost scales with location count (N × the per-location 14-query batch),
// so repeated loads within the TTL — tab switches, the KPI poll, several
// owners of the same account — reuse one computation. 45s staleness is
// invisible next to the pipeline's own multi-second latency.
const AGGREGATE_CACHE_TTL_SECONDS = 45;

function aggregateCacheKey(accountId: string, window: DashboardWindow): string {
  return `dashboard:aggregate:${accountId}:${window}`;
}

/**
 * Builds aggregate dashboard data for all active locations in an account.
 *
 * The function:
 * 1. Fetches all active locations for the account
 * 2. Runs the existing per-location dashboard query for each location
 * 3. Computes aggregate sums across locations
 * 4. Builds per-location breakdown data (KPI strip, velocity, ranking, reviews, briefs)
 *
 * Performance: Each location triggers the same 8-query parallel batch
 * that getActiveDashboardData runs. For accounts with many locations
 * (5+), this could be slow. A future optimization could batch the
 * SQL queries across locations, but the current approach is simpler
 * and correct for the initial implementation.
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

  // Don't pin a degraded payload for the TTL — partial failures should retry
  // on the next request, not be served from cache.
  if ((data.partialFailures?.length ?? 0) === 0) {
    try {
      await getCacheRedis().set(cacheKey, JSON.stringify(data), 'EX', AGGREGATE_CACHE_TTL_SECONDS);
    } catch (err) {
      console.error('[dashboard/aggregate] cache write failed (serving fresh):', err);
    }
  }

  return data;
}

async function buildAggregateDashboardData(
  sql: Sql,
  accountId: string,
  window: DashboardWindow,
): Promise<AggregateDashboardData> {
  const [locations, accountRows] = await Promise.all([
    getLocationsForAccount(sql, accountId),
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
      partialFailures: [],
    };
  }

  // Account-wide reads are independent of the per-location fan-out, so start
  // them alongside it instead of serializing a second query wave after it.
  const totalsPromise = Promise.all([
    getTotalReviewsForAccount(sql, accountId),
    getTotalRespondedForAccount(sql, accountId),
  ]);
  const recentReviewsPromise = getAccountRecentReviews(sql, accountId);

  const locationDataPairs = await mapWithConcurrency(
    locations,
    AGGREGATE_LOCATION_CONCURRENCY,
    async (loc) => {
      try {
        // Fetch the heavy per-location dashboard batch and the authoritative
        // pending count (no LIMIT, held/flagged excluded) together, bounded by
        // the same concurrency cap rather than a second unbounded wave (#346).
        const [data, pendingApprovalCount] = await Promise.all([
          getActiveDashboardData(sql, loc.id, { window }),
          getPendingApprovalCount(sql, loc.id),
        ]);
        return { location: loc, data, pendingApprovalCount };
      } catch (err) {
        console.error(
          `[dashboard/aggregate] Failed to load location=${loc.id} account=${accountId}:`,
          err,
        );
        return null;
      }
    },
  );

  const validPairs = locationDataPairs.filter(
    (p): p is { location: (typeof locations)[number]; data: DashboardDataActive; pendingApprovalCount: number } => p !== null,
  );
  const partialFailures = locationDataPairs
    .map((pair, index) => pair === null ? locations[index] : null)
    .filter((loc): loc is (typeof locations)[number] => loc !== null)
    .map((loc) => ({
      locationId: loc.id,
      displayName: getDisplayLabel(loc),
    }));

  // ── Aggregate Value Summary ──────────────────────────────────────────────
  const totalReviewsHandled = validPairs.reduce(
    (sum, p) => sum + p.data.valueSummary.totalReviewsHandled,
    0,
  );
  const totalTimeSavedMinutes = validPairs.reduce(
    (sum, p) => sum + p.data.valueSummary.totalTimeSavedMinutes,
    0,
  );

  // Aggregate response rate: weighted average across all locations
  const [totalReviewsAcrossLocations, totalRespondedAcrossLocations] = await totalsPromise;
  const currentResponseRate =
    totalReviewsAcrossLocations > 0
      ? Math.round((totalRespondedAcrossLocations / totalReviewsAcrossLocations) * 100)
      : 0;

  // Baseline: use the primary location's baseline if available
  const primaryPair = validPairs.find((p) => p.location.is_primary);
  const baselineResponseRate = primaryPair?.data.valueSummary.baselineResponseRate ?? null;

  // ── Per-Location KPIs (strip) ────────────────────────────────────────────
  // VAL-DASH-028: billingPending is true for locations whose index exceeds
  // the billing-confirmed count (locations_included + locations_paid).
  // This means the Stripe overage webhook hasn't yet confirmed the quantity
  // update for that location.
  // pendingApprovalCount is the authoritative SQL count fetched above via
  // getPendingApprovalCount (no LIMIT, held/flagged excluded) — NOT a filter over
  // the capped recentReviews slice, which undercounts >10 pending (#346).
  // recentReviewCount stays a count of the displayed slice.
  const locationKpis: PerLocationKpi[] = validPairs.map((p, idx) => ({
    locationId: p.location.id,
    displayName: getDisplayLabel(p.location),
    isPrimary: p.location.is_primary,
    totalReviewsHandled: p.data.valueSummary.totalReviewsHandled,
    pendingApprovalCount: p.pendingApprovalCount,
    recentReviewCount: p.data.recentReviews.length,
    billingPending: idx >= billingConfirmedCount,
  }));

  // ── Review Velocity (combined total + per-location) ──────────────────────
  // Merge all week keys across locations, sum counts per week
  const weekMap = new Map<string, number>();
  const perLocationVelocity: PerLocationVelocity[] = [];

  for (const p of validPairs) {
    perLocationVelocity.push({
      locationId: p.location.id,
      displayName: getDisplayLabel(p.location),
      velocity: p.data.reviewVelocity,
    });
    for (const v of p.data.reviewVelocity) {
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

  for (const p of validPairs) {
    const locationRanking = p.data.ranking;
    if (locationRanking) {
      perLocationRanking.push({
        locationId: p.location.id,
        displayName: getDisplayLabel(p.location),
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

  // ── Recent Reviews (combined feed with location chips) ───────────────────
  // One account-wide LIMIT 20 query (started alongside the fan-out above)
  // instead of composing from each location's capped 10-row slice — the old
  // composition both over-fetched (10×N rows) and, past 2 locations, could
  // miss reviews that belonged in the top 20.
  const recentReviews = await recentReviewsPromise;

  // ── Reviews by rating (#405) ─────────────────────────────────────────────
  // Sum the per-location windowed 1–5★ breakdowns. Each location's breakdown is
  // scoped by business_id and the locations are scoped by account_id, so the
  // account-wide rollup leaks no other tenant. Same composition as velocity.
  const ratingBreakdown = sumRatingBreakdowns(
    validPairs.map((p) => p.data.ratingBreakdown),
  );

  // ── Per-Location Briefs ─────────────────────────────────────────────────
  const perLocationBriefs: PerLocationBrief[] = validPairs
    .filter((p) => p.data.latestBrief !== null)
    .map((p) => ({
      locationId: p.location.id,
      displayName: getDisplayLabel(p.location),
      brief: p.data.latestBrief,
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
    partialFailures,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!);
    }
  }));

  return results;
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

// ── Helper queries for accurate aggregate rates ─────────────────────────────

async function getTotalReviewsForAccount(sql: Sql, accountId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM reviews r
    JOIN businesses b ON b.id = r.business_id
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND r.status <> ${REVIEW_STATUS.DELETED}
  `;
  return row?.count ?? 0;
}

async function getTotalRespondedForAccount(sql: Sql, accountId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(DISTINCT r.id)::int AS count
    FROM reviews r
    JOIN responses resp ON resp.review_id = r.id
    JOIN businesses b ON b.id = r.business_id
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND r.status <> ${REVIEW_STATUS.DELETED}
      AND resp.status = ANY(${statusArraySql(sql, HANDLED_STATUSES)})
  `;
  return row?.count ?? 0;
}
