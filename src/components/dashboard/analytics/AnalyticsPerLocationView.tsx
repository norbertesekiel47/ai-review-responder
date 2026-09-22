'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import type { DashboardWindow } from '@/lib/kpi/types';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { Icon } from '@/components/dashboard/shell/Icon';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { AnalyticsTabs } from '@/components/dashboard/analytics/AnalyticsTabs';
import { ReputationHeroBand } from '@/components/dashboard/kpi/ReputationHeroBand';
import { ReputationTrendChart } from '@/components/dashboard/kpi/ReputationTrendChart';
import { IntelligenceBriefCard } from '@/components/dashboard/kpi/IntelligenceBriefCard';
import { RecentRatingBreakdown } from '@/components/dashboard/kpi/RecentRatingBreakdown';
import { VelocityCard } from '@/components/dashboard/kpi/VelocityCard';
import { RankingCard } from '@/components/dashboard/kpi/RankingCard';
import { RecentSentimentMix } from '@/components/dashboard/kpi/RecentSentimentMix';

interface Props {
  active: DashboardDataActive;
  refresh: () => Promise<void>;
  /** Analytics time-range control rendered into the TopBar action slot (#403). */
  periodToolbar?: ReactNode;
  /** The window `active` was fetched for; the rating breakdown states it (#991). */
  window: DashboardWindow;
}

/**
 * Per-location analytics grid: reputation KPI strip -> AI insight -> reputation
 * trend -> two-up velocity/ranking -> recent rating breakdown. Falls back to the
 * "no analytics yet" empty state until any chartable data exists.
 */
export function AnalyticsPerLocationView({ active, refresh, periodToolbar, window }: Props) {
  const reputation = active.reputationSummary;
  const trend = reputation?.trend ?? [];
  const hasRanking = (active.ranking?.length ?? 0) > 0;
  const hasRatingBreakdown = active.ratingBreakdown.total > 0;
  const hasRatedReviews = active.recentReviews.some((review) => review.starRating != null);
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
      >
        {periodToolbar}
      </TopBar>
      <div className="content content--analytics">
        {/* Routed tab bar: first child of the content box, not a capped subnav
            row, so it lines up with the full-bleed analytics grid beneath it.
            Outside the ternary — Restraint stays reachable from the empty
            state, which is exactly when an owner has least to look at here. */}
        <AnalyticsTabs active="metrics" />
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
            <div className={`section-enter section-enter-2${active.latestBrief ? ' chart-row' : ''}`}>
              {active.latestBrief && <IntelligenceBriefCard brief={active.latestBrief} />}
              <ReputationTrendChart trend={trend} />
            </div>
            <div className={`section-enter section-enter-3${hasRanking ? ' chart-row' : ''}`}>
              <VelocityCard reviewVelocity={active.reviewVelocity} />
              {hasRanking && <RankingCard ranking={active.ranking} />}
            </div>
            {(hasRatingBreakdown || hasRatedReviews) && (
              <div className="section-enter section-enter-4 chart-row">
                <RecentRatingBreakdown breakdown={active.ratingBreakdown} window={window} />
                <RecentSentimentMix reviews={active.recentReviews} />
              </div>
            )}
          </>
        ) : (
          <div className="aggregate-empty">
            <div className="empty-emoji" aria-hidden="true">
              <Icon name="trend" size={28} />
            </div>
            <div className="aggregate-empty-title">Your charts are warming up</div>
            <div className="aggregate-empty-sub">
              Once reviews start coming in, you&apos;ll see your reputation trend, review
              volume, and local search ranking here.
            </div>
            <Link href="/dashboard/reviews" className="empty-link">
              <Icon name="inbox" size={13} aria-hidden="true" />
              Go to Reviews
            </Link>
          </div>
        )}
      </div>
    </>
  );
}
