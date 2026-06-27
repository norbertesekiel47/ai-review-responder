'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { ReputationHeroBand } from '@/components/dashboard/kpi/ReputationHeroBand';
import { ReputationTrendChart } from '@/components/dashboard/kpi/ReputationTrendChart';
import { IntelligenceBriefCard } from '@/components/dashboard/kpi/IntelligenceBriefCard';
import { RecentRatingBreakdown } from '@/components/dashboard/kpi/RecentRatingBreakdown';
import { VelocityCard } from '@/components/dashboard/kpi/VelocityCard';
import { RankingCard } from '@/components/dashboard/kpi/RankingCard';

interface Props {
  active: DashboardDataActive;
  refresh: () => Promise<void>;
}

/**
 * Per-location analytics grid: reputation KPI strip -> AI insight -> reputation
 * trend -> two-up velocity/ranking -> recent rating breakdown. Falls back to the
 * "no analytics yet" empty state until any chartable data exists.
 */
export function AnalyticsPerLocationView({ active, refresh }: Props) {
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
