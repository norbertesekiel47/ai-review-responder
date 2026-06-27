'use client';

import type {
  DashboardData,
  DashboardDataPastDue,
} from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { SubscriptionUnavailableCard } from '@/components/dashboard/shell/SubscriptionUnavailableCard';
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';
import { AggregateReviewsCard } from '@/components/dashboard/aggregate/AggregateReviewsCard';
import { ReviewsTabs } from '@/components/dashboard/reviews/ReviewsTabs';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useSyncPendingCount } from '@/hooks/useSyncPendingCount';
import { useLocationScope } from '@/contexts/LocationContext';
import { isAggregate, perLocationActive } from '@/lib/dashboard/scope';

/**
 * /dashboard/reviews — the reviews action queue, moved off the dashboard
 * (PLAN.md 2026-06-19). Per-location -> ReviewsCard; aggregate -> the combined
 * AggregateReviewsCard. Shares the cached /api/dashboard payload.
 */
interface ReviewsContentProps {
  /** Server-authoritative (PAST_REPLIES_VIEW_ENABLED) — gates the History tab. */
  historyEnabled: boolean;
}

export function ReviewsContent({ historyEnabled }: ReviewsContentProps) {
  const { currentScope } = useLocationScope();
  const { data, error, loading, refresh } = useDashboardData(currentScope);
  useSyncPendingCount(data, loading);

  if (loading || !data) {
    return (
      <>
        <TopBar title="Reviews" />
        <div className="content">
          <LiveRegion message="Loading your reviews…" />
          <div className="dashboard-skeleton">
            <div className="skeleton-card-lg" />
          </div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <TopBar title="Reviews" />
        <div className="content">
          <LiveRegion message={error} level="assertive" />
          <div className="card">
            <h2 className="card-h2">Unable to load reviews</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 4 }}>{error}</p>
          </div>
        </div>
      </>
    );
  }

  if (isAggregate(data)) {
    return (
      <>
        <TopBar
          title="Reviews"
          subtitle="Drafts awaiting your approval across all locations."
          showLive
          refresh={refresh}
        />
        <div className="reviews-subnav">
          <ReviewsTabs active="needs" historyEnabled={historyEnabled} />
        </div>
        <div className="content content--reviews">
          <div className="section-enter section-enter-1">
            <AggregateReviewsCard
              recentReviews={data.recentReviews}
              onActionSuccess={() => { void refresh(); }}
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
        subtitle="Drafts awaiting your approval — approve, edit, or regenerate."
        showLive
        refresh={refresh}
      />
      <div className="reviews-subnav">
        <ReviewsTabs active="needs" historyEnabled={historyEnabled} />
      </div>
      <div className="content content--reviews">
        <div className="section-enter section-enter-1">
          <ReviewsCard
            recentReviews={active.recentReviews}
            onActionSuccess={() => { void refresh(); }}
            readOnly={isReadOnly}
          />
        </div>
      </div>
    </>
  );
}
