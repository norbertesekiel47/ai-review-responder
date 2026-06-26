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
import { ReputationHeroBand } from '@/components/dashboard/kpi/ReputationHeroBand';
import { ReputationTrendChart } from '@/components/dashboard/kpi/ReputationTrendChart';
import { IntelligenceBriefCard } from '@/components/dashboard/kpi/IntelligenceBriefCard';
import { RecentRatingBreakdown } from '@/components/dashboard/kpi/RecentRatingBreakdown';
import { VelocityCard } from '@/components/dashboard/kpi/VelocityCard';
import { RankingCard } from '@/components/dashboard/kpi/RankingCard';
import { AggregateKpiCards } from '@/components/dashboard/aggregate/AggregateKpiCards';
import { AggregateIntelligenceBriefCard } from '@/components/dashboard/aggregate/AggregateIntelligenceBriefCard';
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
 * /dashboard/analytics — depth, moved off the glance dashboard. A headline-first
 * analytics grid: a reputation KPI strip, an optional AI insight, the reputation
 * trend, a two-up velocity/ranking row, and a recent-rating breakdown. Shares the
 * cached /api/dashboard payload via useDashboardData — same per-location and
 * aggregate scopes as the dashboard, each keeping its own component set.
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
    const hasRanking = Boolean(data.ranking) || data.perLocationRanking.length > 0;
    return (
      <>
        <TopBar
          title="Analytics"
          subtitle="Review volume and local search ranking across all locations."
          showLive
          refresh={refresh}
        />
        <div className="content">
          <LiveRegion message="Analytics ready." />
          <div className="section-enter section-enter-1">
            <AggregateKpiCards
              valueSummary={data.valueSummary}
              activeLocationCount={data.activeLocationCount}
            />
          </div>
          {data.perLocationBriefs.length > 0 && (
            <div className="section-enter section-enter-2">
              <AggregateIntelligenceBriefCard perLocationBriefs={data.perLocationBriefs} />
            </div>
          )}
          <div className={`section-enter section-enter-3${hasRanking ? ' chart-row' : ''}`}>
            <AggregateVelocityCard
              reviewVelocity={data.reviewVelocity}
              perLocationVelocity={data.perLocationVelocity}
            />
            {hasRanking && (
              <AggregateRankingCard
                ranking={data.ranking}
                perLocationRanking={data.perLocationRanking}
              />
            )}
          </div>
          <div className="section-enter section-enter-4">
            <RecentRatingBreakdown reviews={data.recentReviews} />
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

  const reputation = active.reputationSummary;
  const trend = reputation?.trend ?? [];
  const hasRanking = (active.ranking?.length ?? 0) > 0;
  const hasAnything =
    trend.some((week) => week.starEquivalent != null) ||
    active.reviewVelocity.length > 0 ||
    hasRanking;

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
            <LiveRegion message="Analytics ready." />
            {reputation && (
              <div className="section-enter section-enter-1">
                <ReputationHeroBand
                  summary={reputation}
                  lifetimeReviewsHandled={active.valueSummary.totalReviewsHandled}
                  lifetimeTimeSavedMinutes={active.valueSummary.totalTimeSavedMinutes}
                  connected={active.zernioConnection.status === 'active'}
                />
              </div>
            )}
            {active.latestBrief && (
              <div className="section-enter section-enter-2">
                <IntelligenceBriefCard brief={active.latestBrief} />
              </div>
            )}
            <div className="section-enter section-enter-3">
              <ReputationTrendChart trend={trend} />
            </div>
            <div className={`section-enter section-enter-4${hasRanking ? ' chart-row' : ''}`}>
              <VelocityCard reviewVelocity={active.reviewVelocity} />
              {hasRanking && <RankingCard ranking={active.ranking} />}
            </div>
            <div className="section-enter section-enter-5">
              <RecentRatingBreakdown reviews={active.recentReviews} />
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
