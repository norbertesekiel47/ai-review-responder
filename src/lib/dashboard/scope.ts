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
 * Authoritative count of owner drafts awaiting approval, derived ONLY from the
 * SQL-backed fields in the payload — never the capped `recentReviews` slice,
 * which undercounts past ~10 pending (issue #346).
 *
 *   aggregate              → Σ locationKpis[].pendingApprovalCount
 *   per-loc active/pastdue  → reputationSummary.pendingApprovalCount
 *   else / null            → 0
 *
 * `reputationSummary` is always present on the per-location route (it always
 * passes includeReputationMetrics). The `?? 0` is a guard for that impossible
 * state: 0 ("no authoritative data → no badge") never lies, whereas falling back
 * to the capped slice would re-introduce the exact undercount this fixes.
 */
export function authoritativePendingCount(data: DashboardPayload | null): number {
  if (!data) return 0;
  if (isAggregate(data)) {
    return data.locationKpis.reduce((sum, kpi) => sum + kpi.pendingApprovalCount, 0);
  }
  const active = perLocationActive(data);
  if (!active) return 0;
  return active.reputationSummary?.pendingApprovalCount ?? 0;
}
