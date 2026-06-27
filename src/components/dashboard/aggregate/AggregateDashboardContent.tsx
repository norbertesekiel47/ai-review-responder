'use client';

import { useEffect } from 'react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { AggregateKpiCards } from '@/components/dashboard/aggregate/AggregateKpiCards';
import { PendingApprovalsStrip } from '@/components/dashboard/kpi/PendingApprovalsStrip';
import { AggregateIntelligenceBriefCard } from '@/components/dashboard/aggregate/AggregateIntelligenceBriefCard';
import { LocationKpiStrip } from '@/components/dashboard/aggregate/LocationKpiStrip';
import { PastDueBanner } from '@/components/dashboard/account-state/SubscriptionStatusBanner';
import { PastDueModal } from '@/components/dashboard/account-state/PastDueModal';
import { useSetPendingCount } from '@/contexts/PendingCountContext';
import { authoritativePendingCount } from '@/lib/dashboard/scope';

interface Props {
  data: AggregateDashboardData;
  refresh: () => Promise<void>;
}

/**
 * Renders the "All Locations" aggregate dashboard glance. Velocity + ranking
 * charts moved to /dashboard/analytics (design spec 2026-06-19); the dashboard
 * keeps only the glanceable zones.
 *
 * Layout:
 *  1. TopBar with aggregate title
 *  2. Aggregate KpiCards (summed values)
 *  3. PendingApprovalsStrip (links to /dashboard/reviews)
 *  4. Location KPI strip (clickable per-location cards)
 *  5. IntelligenceBriefCard (per-location prefix bullets)
 */
export function AggregateDashboardContent({ data, refresh }: Props) {
  const setPendingCount = useSetPendingCount();

  // Authoritative pending count across all locations — sum of the SQL-backed
  // per-location counts, NOT a filter over the capped recentReviews slice, which
  // undercounts past ~10 pending (#346). Matches the parent badge value.
  const pendingCount = authoritativePendingCount(data);

  useEffect(() => {
    setPendingCount(pendingCount);
  }, [pendingCount, setPendingCount]);

  // VAL-DASH-026: Empty state when no reviews at any location
  const hasNoData =
    data.valueSummary.totalReviewsHandled === 0 &&
    data.recentReviews.length === 0 &&
    data.ranking === null;

  const subtitle = data.subscriptionStatus === SubscriptionStatus.PAST_DUE
    ? 'Payment overdue — please update your payment method'
    : `Welcome back — here's what's new across your ${data.activeLocationCount} location${data.activeLocationCount !== 1 ? 's' : ''}.`;

  return (
    <>
      <TopBar title="Dashboard" subtitle={subtitle} showLive refresh={refresh} />
      <div className="content">
        {data.subscriptionStatus === SubscriptionStatus.PAST_DUE && (
          <div className="section-enter section-enter-1">
            <PastDueBanner
              billingPortalUrl={data.billingPortalUrl ?? null}
              pastDueAt={data.pastDueAt ?? null}
              deadline={data.pastDueDeadline ?? null}
              daysRemaining={data.daysRemaining ?? null}
              isReadOnly={data.isReadOnly ?? false}
            />
            {data.accountId && (
              <PastDueModal
                accountId={data.accountId}
                daysRemaining={data.daysRemaining ?? null}
                isReadOnly={data.isReadOnly ?? false}
                deadline={data.pastDueDeadline ?? null}
              />
            )}
          </div>
        )}
        {hasNoData ? (
          <div className="aggregate-empty">
            <div className="aggregate-empty-emoji">📊</div>
            <div className="aggregate-empty-title">No reviews yet across your locations</div>
            <div className="aggregate-empty-sub">
              Once reviews start coming in, you&apos;ll see your aggregate performance metrics here.
              We&apos;ll notify you as soon as the first review arrives.
            </div>
          </div>
        ) : (
          <>
            <div className="section-enter section-enter-1">
              <AggregateKpiCards
                valueSummary={data.valueSummary}
                activeLocationCount={data.activeLocationCount}
              />
            </div>
            <div className="section-enter section-enter-2">
              <PendingApprovalsStrip count={pendingCount} />
            </div>
            <div className="section-enter section-enter-3">
              <LocationKpiStrip locationKpis={data.locationKpis} />
            </div>
            {data.perLocationBriefs.length > 0 && (
              <div className="section-enter section-enter-4">
                <AggregateIntelligenceBriefCard perLocationBriefs={data.perLocationBriefs} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
