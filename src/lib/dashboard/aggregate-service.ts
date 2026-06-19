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

import { sql } from '@/lib/db/server';
import { getActiveDashboardData } from './service';
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
  accountId: string,
): Promise<AggregateDashboardData> {
  const [locations, accountRows] = await Promise.all([
    getLocationsForAccount(accountId),
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

  const locationDataPairs = await mapWithConcurrency(
    locations,
    AGGREGATE_LOCATION_CONCURRENCY,
    async (loc) => {
      try {
        const data = await getActiveDashboardData(loc.id);
        return { location: loc, data };
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
    (p): p is { location: (typeof locations)[number]; data: DashboardDataActive } => p !== null,
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
  const [totalReviewsAcrossLocations, totalRespondedAcrossLocations] = await Promise.all([
    getTotalReviewsForAccount(accountId),
    getTotalRespondedForAccount(accountId),
  ]);
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
  const locationKpis: PerLocationKpi[] = validPairs.map((p, idx) => {
    const pendingCount = p.data.recentReviews.filter(
      (r) => (r.responseStatus ?? r.status) === 'pending_approval',
    ).length;
    const recentCount = p.data.recentReviews.length;
    return {
      locationId: p.location.id,
      displayName: getDisplayLabel(p.location),
      isPrimary: p.location.is_primary,
      totalReviewsHandled: p.data.valueSummary.totalReviewsHandled,
      pendingApprovalCount: pendingCount,
      recentReviewCount: recentCount,
      billingPending: idx >= billingConfirmedCount,
    };
  });

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
  const allReviews: AggregateReviewItem[] = [];
  for (const p of validPairs) {
    const displayName = getDisplayLabel(p.location);
    for (const r of p.data.recentReviews) {
      allReviews.push({
        ...r,
        locationId: p.location.id,
        locationDisplayName: displayName,
      });
    }
  }
  // Sort by reviewDate descending (most recent first)
  allReviews.sort((a, b) => b.reviewDate.localeCompare(a.reviewDate));
  // Limit to 20 items total across all locations
  const recentReviews = allReviews.slice(0, 20);

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

// ── Helper queries for accurate aggregate rates ─────────────────────────────

async function getTotalReviewsForAccount(accountId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM reviews r
    JOIN businesses b ON b.id = r.business_id
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND r.status <> 'deleted'
  `;
  return row?.count ?? 0;
}

async function getTotalRespondedForAccount(accountId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(DISTINCT r.id)::int AS count
    FROM reviews r
    JOIN responses resp ON resp.review_id = r.id
    JOIN businesses b ON b.id = r.business_id
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND r.status <> 'deleted'
      AND resp.status = ANY(ARRAY['approved', 'posted', 'edited', 'awaiting_owner_connect']::text[])
  `;
  return row?.count ?? 0;
}
