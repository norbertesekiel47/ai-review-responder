'use client';

import { useCallback } from 'react';
import type {
  DashboardData,
  DashboardDataPastDue,
} from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { renderDashboardStatePanel } from '@/components/dashboard/shell/DashboardStatePanel';
import { RefreshHoldProvider } from '@/components/dashboard/shell/refresh-hold';
import { SubscriptionUnavailableCard } from '@/components/dashboard/shell/SubscriptionUnavailableCard';
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';
import { AggregateReviewsCard } from '@/components/dashboard/aggregate/AggregateReviewsCard';
import { ReviewsTabs } from '@/components/dashboard/reviews/ReviewsTabs';
import { usePendingApprovals } from '@/components/dashboard/reviews/usePendingApprovals';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useSyncPendingCount } from '@/hooks/useSyncPendingCount';
import { useLocationScope } from '@/contexts/LocationContext';
import { isAggregate, perLocationActive } from '@/lib/dashboard/scope';

/**
 * /dashboard/reviews — the reviews action queue, moved off the dashboard
 * (PLAN.md 2026-06-19). The queue rows come from the pending-approvals read
 * (paged, authoritative totals — UX audit D2); the cached /api/dashboard
 * payload still answers for subscription state, read-only mode and the nav
 * badge. Per-location -> ReviewsCard; aggregate -> AggregateReviewsCard.
 *
 * Wrapped in a RefreshHoldProvider so a row mid-edit (or waiting on a
 * regenerated draft) can pause the TopBar's 60 s auto-refresh (D1).
 */
export function ReviewsContent() {
  return (
    <RefreshHoldProvider>
      <ReviewsQueue />
    </RefreshHoldProvider>
  );
}

function ReviewsQueue() {
  const { currentScope } = useLocationScope();
  const dashboard = useDashboardData(currentScope);
  const queue = usePendingApprovals(currentScope);
  useSyncPendingCount(dashboard.data, dashboard.loading);

  const refreshDashboard = dashboard.refresh;
  const refetchQueue = queue.refetch;
  const refresh = useCallback(async () => {
    await Promise.all([refreshDashboard(), refetchQueue()]);
  }, [refreshDashboard, refetchQueue]);

  // Loading/error scaffold (shared) only while nothing is on screen yet: a
  // background refresh keeps the stale rows visible (D1), and a failed FIRST
  // fetch shows the error card rather than an endless skeleton (D3).
  const { data } = dashboard;
  if (!data || queue.items === null) {
    return renderDashboardStatePanel('reviews', {
      loading: dashboard.loading || queue.loading,
      hasData: false,
      error: dashboard.error ?? queue.error,
    });
  }

  const refreshing = dashboard.refreshing;

  if (isAggregate(data)) {
    return (
      <>
        <TopBar
          title="Reviews"
          subtitle="Drafts awaiting your approval across all locations."
          showLive
          refresh={refresh}
          refreshing={refreshing}
        />
        <div className="reviews-subnav reviews-subnav--tabs-only">
          <ReviewsTabs active="needs" />
        </div>
        <div className="content content--reviews">
          <div className="section-enter section-enter-1">
            <AggregateReviewsCard
              items={queue.items}
              pendingTotal={queue.pendingTotal}
              total={queue.total}
              hasMore={queue.hasMore}
              loadingMore={queue.loadingMore}
              onLoadMore={queue.loadMore}
              onActionSuccess={refresh}
              readOnly={data.isReadOnly ?? false}
            />
          </div>
        </div>
      </>
    );
  }

  const active = perLocationActive(data);
  if (!active) {
    return (
      <SubscriptionUnavailableCard
        topBarTitle="Reviews"
        heading="Reviews aren't available right now"
        body="Your account needs an active subscription to review drafts."
      />
    );
  }

  const isReadOnly =
    (data as DashboardData).subscriptionStatus === SubscriptionStatus.PAST_DUE
      ? Boolean((data as DashboardDataPastDue).isReadOnly)
      : false;

  return (
    <>
      <TopBar
        title="Reviews"
        subtitle="Drafts awaiting your approval. Approve, edit, or regenerate."
        showLive
        refresh={refresh}
        refreshing={refreshing}
      />
      <div className="reviews-subnav reviews-subnav--tabs-only">
        <ReviewsTabs active="needs" />
      </div>
      <div className="content content--reviews">
        <div className="section-enter section-enter-1">
          <ReviewsCard
            items={queue.items}
            pendingTotal={queue.pendingTotal}
            total={queue.total}
            hasMore={queue.hasMore}
            loadingMore={queue.loadingMore}
            onLoadMore={queue.loadMore}
            onActionSuccess={refresh}
            readOnly={isReadOnly}
          />
        </div>
      </div>
    </>
  );
}
