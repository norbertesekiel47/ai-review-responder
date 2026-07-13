import { describe, it, expect } from 'vitest';
import { authoritativePendingCount } from '../scope';
import type {
  DashboardData,
  DashboardDataActive,
  AggregateDashboardData,
} from '../types';

/** N pending_approval recentReviews rows (per-location shape). */
function recentPending(n: number): DashboardDataActive['recentReviews'] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    reviewerName: 'Reviewer',
    starRating: 5,
    reviewText: null,
    reviewDate: '2026-06-01',
    status: 'pending_approval',
    responseText: 'draft',
    responseStatus: 'pending_approval',
    approvalMethod: null,
    autoPostScheduledAt: null,
    escalation: null,
  }));
}

/** Active per-location payload. `reputationPending: undefined` omits reputationSummary. */
function activePayload(opts: {
  reputationPending?: number;
  recentPendingCount: number;
}): DashboardDataActive {
  const payload: Partial<DashboardDataActive> = {
    recentReviews: recentPending(opts.recentPendingCount),
  };
  if (opts.reputationPending !== undefined) {
    payload.reputationSummary = {
      averageStar: { current: null, delta: null, priorSampleSize: 0 },
      responseRate: { current: 0, delta: null, priorSampleSize: 0 },
      timeSavedMinutes: { current: 0, delta: null, priorSampleSize: 0 },
      pendingApprovalCount: opts.reputationPending,
      trend: [],
      isRamping: false,
    };
  }
  return payload as DashboardDataActive;
}

/** Aggregate payload with one locationKpi per count. recentReviews stays empty. */
function aggregatePayload(kpiCounts: number[]): AggregateDashboardData {
  const payload: Partial<AggregateDashboardData> = {
    scope: 'aggregate',
    recentReviews: [],
    locationKpis: kpiCounts.map((count, i) => ({
      locationId: `loc${i}`,
      displayName: `Loc ${i}`,
      isPrimary: i === 0,
      totalReviewsHandled: 0,
      pendingApprovalCount: count,
      recentReviewCount: 0,
      billingPending: false,
    })),
  };
  return payload as AggregateDashboardData;
}

describe('authoritativePendingCount', () => {
  it('per-location: returns reputationSummary count, not the capped slice (>10 regression)', () => {
    const data = activePayload({ reputationPending: 15, recentPendingCount: 10 });
    expect(authoritativePendingCount(data)).toBe(15);
  });

  it('aggregate: sums locationKpis pending counts, not the capped slice (>10 regression)', () => {
    const data = aggregatePayload([8, 9]);
    expect(authoritativePendingCount(data)).toBe(17);
  });

  it('past_due per-location: reads the authoritative reputationSummary count', () => {
    const base = activePayload({ reputationPending: 12, recentPendingCount: 3 });
    const pastDue = { ...base, subscriptionStatus: 'past_due' } as unknown as DashboardData;
    expect(authoritativePendingCount(pastDue)).toBe(12);
  });

  it('per-location without reputationSummary (impossible state): returns 0, never the capped slice', () => {
    // 3 pending in the capped slice, but no authoritative summary → 0, NOT 3.
    const data = activePayload({ recentPendingCount: 3 });
    expect(authoritativePendingCount(data)).toBe(0);
  });

  it('non-active per-location status returns 0', () => {
    const pendingPayment: DashboardData = {
      subscriptionStatus: 'pending_payment',
      businessId: 'b1',
      businessName: 'Biz',
      paymentUrl: null,
    };
    expect(authoritativePendingCount(pendingPayment)).toBe(0);
  });

  it('null payload returns 0', () => {
    expect(authoritativePendingCount(null)).toBe(0);
  });
});
