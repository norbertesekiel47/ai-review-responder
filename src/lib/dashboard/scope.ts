import type {
  DashboardData,
  DashboardDataActive,
  AggregateDashboardData,
} from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

/** The two shapes the cached /api/dashboard payload can take. */
export type DashboardPayload = DashboardData | AggregateDashboardData;

/** Narrow the dashboard payload to the multi-location aggregate shape. */
export function isAggregate(data: DashboardPayload): data is AggregateDashboardData {
  return 'scope' in data && data.scope === 'aggregate';
}

/**
 * The per-location payload that carries chart/review content. Both an active
 * subscription (status undefined) and past_due (7-day grace) qualify; any other
 * status returns null so callers render the unavailable state.
 */
export function perLocationActive(data: DashboardPayload): DashboardDataActive | null {
  if (isAggregate(data)) return null;
  const status = (data as DashboardData).subscriptionStatus;
  if (status !== undefined && status !== SubscriptionStatus.PAST_DUE) return null;
  return data as DashboardDataActive;
}

/**
 * Authoritative count of owner drafts awaiting approval, derived from the
 * SQL-backed fields already present in the payload — NOT the capped
 * `recentReviews` slice, which undercounts past ~10 pending (issue #346).
 *
 *   aggregate              → Σ locationKpis[].pendingApprovalCount
 *   per-loc active/pastdue  → reputationSummary.pendingApprovalCount
 *   else / null            → 0
 *
 * The per-location branch falls back to filtering `recentReviews` only when
 * `reputationSummary` is absent — an impossible state for the active
 * per-location route (it always passes includeReputationMetrics), kept purely
 * as a defensive guard so the count can never regress below today's behavior.
 */
export function authoritativePendingCount(data: DashboardPayload | null): number {
  if (!data) return 0;
  if (isAggregate(data)) {
    return data.locationKpis.reduce((sum, kpi) => sum + kpi.pendingApprovalCount, 0);
  }
  const active = perLocationActive(data);
  if (!active) return 0;
  return (
    active.reputationSummary?.pendingApprovalCount ??
    active.recentReviews.filter(
      (review) => (review.responseStatus ?? review.status) === 'pending_approval',
    ).length
  );
}
