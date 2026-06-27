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
