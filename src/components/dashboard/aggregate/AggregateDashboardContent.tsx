'use client';

import { useEffect, useRef } from 'react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { AggregateKpiCards } from '@/components/dashboard/aggregate/AggregateKpiCards';
import { AggregateReviewsCard } from '@/components/dashboard/aggregate/AggregateReviewsCard';
import { AggregateVelocityCard } from '@/components/dashboard/aggregate/AggregateVelocityCard';
import { AggregateRankingCard } from '@/components/dashboard/aggregate/AggregateRankingCard';
import { AggregateIntelligenceBriefCard } from '@/components/dashboard/aggregate/AggregateIntelligenceBriefCard';
import { LocationKpiStrip } from '@/components/dashboard/aggregate/LocationKpiStrip';
import { PastDueBanner } from '@/components/dashboard/account-state/SubscriptionStatusBanner';
import { PastDueModal } from '@/components/dashboard/account-state/PastDueModal';
import { useSetPendingCount } from '@/contexts/PendingCountContext';
import { useNeedsActionHashScroll } from '@/hooks/useNeedsActionHashScroll';

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
 *  3. Location KPI strip (clickable per-location cards)
 *  4. ReviewsCard (combined feed with location chips)
 *  5. VelocityCard (stacked-by-location toggle)
 *  6. RankingCard (per-location ranking lines)
 *  7. IntelligenceBriefCard (per-location prefix bullets)
 */
export function AggregateDashboardContent({ data, refresh }: Props) {
  const setPendingCount = useSetPendingCount();
  const reviewsRef = useRef<HTMLDivElement | null>(null);
  // The "needs" tab intent is recorded but never read on the render path, so a
  // ref avoids the no-op re-render a state setter would queue when the hash
  // scroll fires.
  const initialTabRef = useRef<'needs' | 'all'>('needs');

  useNeedsActionHashScroll(reviewsRef, () => { initialTabRef.current = 'needs'; });

  // Compute pending count across all locations
  const pendingCount = data.recentReviews.filter(
    (r) => (r.responseStatus ?? r.status) === 'pending_approval',
  ).length;

  useEffect(() => {
    setPendingCount(pendingCount);
  }, [pendingCount, setPendingCount]);

  function scrollToReviews() {
    if (reviewsRef.current) {
      const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }

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
                pendingCount={pendingCount}
                activeLocationCount={data.activeLocationCount}
                onScrollToReviews={scrollToReviews}
              />
            </div>
            <div className="section-enter section-enter-2">
              <LocationKpiStrip locationKpis={data.locationKpis} />
            </div>
            <div className="section-enter section-enter-3">
              <AggregateReviewsCard
                recentReviews={data.recentReviews}
                onActionSuccess={() => { void refresh(); }}
                ref={reviewsRef}
                readOnly={data.isReadOnly ?? false}
              />
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
