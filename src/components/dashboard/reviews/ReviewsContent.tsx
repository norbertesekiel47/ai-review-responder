'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import type {
  DashboardData,
  DashboardDataActive,
  DashboardDataPastDue,
  AggregateDashboardData,
} from '@/lib/dashboard/types';
import type { DashboardOrAggregate } from '@/hooks/useDashboardData';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';
import { AggregateReviewsCard } from '@/components/dashboard/aggregate/AggregateReviewsCard';
import { ReviewsTabs } from '@/components/dashboard/reviews/ReviewsTabs';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope } from '@/contexts/LocationContext';
import { useSetPendingCount } from '@/contexts/PendingCountContext';

function isAggregate(data: DashboardOrAggregate): data is AggregateDashboardData {
  return 'scope' in data && data.scope === 'aggregate';
}

/** Active (status undefined) and past_due both carry recentReviews. */
function perLocationActive(data: DashboardOrAggregate): DashboardDataActive | null {
  if (isAggregate(data)) return null;
  const status = (data as DashboardData).subscriptionStatus;
  if (status !== undefined && status !== SubscriptionStatus.PAST_DUE) return null;
  return data as DashboardDataActive;
}

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
  const setPendingCount = useSetPendingCount();

  const pending =
    data && !loading
      ? (isAggregate(data)
          ? data.recentReviews
          : (perLocationActive(data)?.recentReviews ?? [])
        ).filter((r) => (r.responseStatus ?? r.status) === 'pending_approval').length
      : 0;

  useEffect(() => {
    setPendingCount(pending);
  }, [pending, setPendingCount]);

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
        <div className="content">
          <ReviewsTabs active="needs" historyEnabled={historyEnabled} />
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
      <>
        <TopBar title="Reviews" />
        <div className="content">
          <div className="card">
            <h2 className="card-h2">Reviews aren&apos;t available right now</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              Your account needs an active subscription to review drafts.{' '}
              <Link href="/dashboard" style={{ color: 'var(--rw-sage-deep)', fontWeight: 600 }}>
                Back to dashboard
              </Link>
            </p>
          </div>
        </div>
      </>
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
      <div className="content">
        <ReviewsTabs active="needs" historyEnabled={historyEnabled} />
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
