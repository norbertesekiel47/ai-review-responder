'use client';

import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { RecentRatingBreakdown } from '@/components/dashboard/kpi/RecentRatingBreakdown';
import { AggregateKpiCards } from '@/components/dashboard/aggregate/AggregateKpiCards';
import { AggregateIntelligenceBriefCard } from '@/components/dashboard/aggregate/AggregateIntelligenceBriefCard';
import { AggregateVelocityCard } from '@/components/dashboard/aggregate/AggregateVelocityCard';
import { AggregateRankingCard } from '@/components/dashboard/aggregate/AggregateRankingCard';

interface Props {
  data: AggregateDashboardData;
  refresh: () => Promise<void>;
}

/**
 * Aggregate (all-locations) analytics grid: KPI strip -> AI insight ->
 * two-up velocity/ranking -> recent rating breakdown. No reputation trend —
 * the aggregate payload carries no trend series.
 */
export function AnalyticsAggregateView({ data, refresh }: Props) {
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
