'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import type {
  DashboardData,
  DashboardDataActive,
  AggregateDashboardData,
} from '@/lib/dashboard/types';
import type { DashboardOrAggregate } from '@/hooks/useDashboardData';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { ReputationTrendChart } from '@/components/dashboard/kpi/ReputationTrendChart';
import { VelocityCard } from '@/components/dashboard/kpi/VelocityCard';
import { RankingCard } from '@/components/dashboard/kpi/RankingCard';
import { AggregateVelocityCard } from '@/components/dashboard/aggregate/AggregateVelocityCard';
import { AggregateRankingCard } from '@/components/dashboard/aggregate/AggregateRankingCard';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope } from '@/contexts/LocationContext';
import { useSetPendingCount } from '@/contexts/PendingCountContext';

function isAggregate(data: DashboardOrAggregate): data is AggregateDashboardData {
  return 'scope' in data && data.scope === 'aggregate';
}

/** Active (status undefined) and past_due both carry the chart payload. */
function perLocationActive(data: DashboardOrAggregate): DashboardDataActive | null {
  if (isAggregate(data)) return null;
  const status = (data as DashboardData).subscriptionStatus;
  if (status !== undefined && status !== SubscriptionStatus.PAST_DUE) return null;
  return data as DashboardDataActive;
}

/**
 * /dashboard/analytics — depth, moved off the glance dashboard (design spec
 * 2026-06-19). Re-homes the three charts (trend · velocity · ranking) behind a
 * headline-first layout. Shares the cached /api/dashboard payload via
 * useDashboardData — same per-location and aggregate scopes as the dashboard.
 */
export function AnalyticsContent() {
  const { currentScope } = useLocationScope();
  const { data, error, loading, refresh } = useDashboardData(currentScope);
  const setPendingCount = useSetPendingCount();

  const pending =
    data && !loading
      ? (isAggregate(data)
          ? data.recentReviews
          : (perLocationActive(data)?.recentReviews ?? [])
        ).filter((review) => (review.responseStatus ?? review.status) === 'pending_approval').length
      : 0;

  useEffect(() => {
    setPendingCount(pending);
  }, [pending, setPendingCount]);

  if (loading || !data) {
    return (
      <>
        <TopBar title="Analytics" />
        <div className="content">
          <LiveRegion message="Loading your analytics…" />
          <div className="dashboard-skeleton">
            <div className="skeleton-card-lg" />
            <div className="skeleton-card-lg" />
          </div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <TopBar title="Analytics" />
        <div className="content">
          <LiveRegion message={error} level="assertive" />
          <div className="card">
            <h2 className="card-h2">Unable to load analytics</h2>
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
          title="Analytics"
          subtitle="Review volume and local search ranking across all locations."
          showLive
          refresh={refresh}
        />
        <div className="content">
          <div className="section-enter section-enter-1">
            <AggregateVelocityCard
              reviewVelocity={data.reviewVelocity}
              perLocationVelocity={data.perLocationVelocity}
            />
          </div>
          <div className="section-enter section-enter-2">
            <AggregateRankingCard
              ranking={data.ranking}
              perLocationRanking={data.perLocationRanking}
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
        <TopBar title="Analytics" />
        <div className="content">
          <div className="card">
            <h2 className="card-h2">Analytics aren&apos;t available right now</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              Your account needs an active subscription to see reputation analytics.{' '}
              <Link href="/dashboard" style={{ color: 'var(--rw-sage-deep)', fontWeight: 600 }}>
                Back to dashboard
              </Link>
            </p>
          </div>
        </div>
      </>
    );
  }

  const trend = active.reputationSummary?.trend ?? [];
  const hasAnything =
    trend.some((week) => week.starEquivalent != null) ||
    active.reviewVelocity.length > 0 ||
    (active.ranking?.length ?? 0) > 0;

  return (
    <>
      <TopBar
        title="Analytics"
        subtitle="How your reputation, review volume, and local ranking are trending."
        showLive
        refresh={refresh}
      />
      <div className="content">
        {hasAnything ? (
          <>
            <div className="section-enter section-enter-1">
              <ReputationTrendChart trend={trend} />
            </div>
            <div className="section-enter section-enter-2">
              <VelocityCard reviewVelocity={active.reviewVelocity} />
            </div>
            <div className="section-enter section-enter-3">
              <RankingCard ranking={active.ranking} />
            </div>
          </>
        ) : (
          <div className="aggregate-empty">
            <div className="aggregate-empty-emoji">📈</div>
            <div className="aggregate-empty-title">No analytics yet</div>
            <div className="aggregate-empty-sub">
              Once reviews start coming in, you&apos;ll see your reputation trend, review
              volume, and local search ranking here.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
