'use client';

import { useEffect } from 'react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { AggregateKpiCards } from '@/components/dashboard/aggregate/AggregateKpiCards';
import { PendingApprovalsStrip } from '@/components/dashboard/kpi/PendingApprovalsStrip';
import { AggregateVelocityCard } from '@/components/dashboard/aggregate/AggregateVelocityCard';
import { AggregateRankingCard } from '@/components/dashboard/aggregate/AggregateRankingCard';
import { AggregateIntelligenceBriefCard } from '@/components/dashboard/aggregate/AggregateIntelligenceBriefCard';
import { LocationKpiStrip } from '@/components/dashboard/aggregate/LocationKpiStrip';
import { PastDueBanner } from '@/components/dashboard/account-state/SubscriptionStatusBanner';
import { PastDueModal } from '@/components/dashboard/account-state/PastDueModal';
import { useSetPendingCount } from '@/contexts/PendingCountContext';

interface Props {
  data: AggregateDashboardData;
  refresh: () => Promise<void>;
}

/**
 * Renders the "All Locations" aggregate dashboard view.
 *
 * Layout:
 *  1. TopBar with aggregate title
 *  2. Aggregate KpiCards (summed values)
 *  3. PendingApprovalsStrip (links to /dashboard/reviews)
 *  4. Location KPI strip (clickable per-location cards)
 *  5. VelocityCard (stacked-by-location toggle)
 *  6. RankingCard (per-location ranking lines)
 *  7. IntelligenceBriefCard (per-location prefix bullets)
 */
export function AggregateDashboardContent({ data, refresh }: Props) {
  const setPendingCount = useSetPendingCount();

  // Compute pending count across all locations
  const pendingCount = data.recentReviews.filter(
    (r) => (r.responseStatus ?? r.status) === 'pending_approval',
  ).length;

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
            <div className="section-enter section-enter-4">
              <AggregateVelocityCard
                reviewVelocity={data.reviewVelocity}
                perLocationVelocity={data.perLocationVelocity}
              />
            </div>
            <div className="section-enter section-enter-5">
              <AggregateRankingCard
                ranking={data.ranking}
                perLocationRanking={data.perLocationRanking}
              />
            </div>
            {data.perLocationBriefs.length > 0 && (
              <div className="section-enter section-enter-6">
                <AggregateIntelligenceBriefCard perLocationBriefs={data.perLocationBriefs} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
