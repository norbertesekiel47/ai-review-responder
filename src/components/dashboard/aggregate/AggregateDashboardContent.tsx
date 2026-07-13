'use client';

import type { AggregateDashboardData } from '@/lib/dashboard/types';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { AggregateKpiCards } from '@/components/dashboard/aggregate/AggregateKpiCards';
import { PendingApprovalsStrip } from '@/components/dashboard/kpi/PendingApprovalsStrip';
import { LocationKpiStrip } from '@/components/dashboard/aggregate/LocationKpiStrip';
import { AnalyticsLinkCard } from '@/components/dashboard/kpi/AnalyticsLinkCard';
import { PastDueBanner } from '@/components/dashboard/account-state/SubscriptionStatusBanner';
import { PastDueModal } from '@/components/dashboard/account-state/PastDueModal';
import { authoritativePendingCount } from '@/lib/dashboard/scope';
import { AgentTeamStrip } from '@/components/dashboard/AgentTeamStrip';
import { NeedsAttentionList } from '@/components/dashboard/NeedsAttentionList';

interface Props {
  data: AggregateDashboardData;
  refresh: () => Promise<void>;
}

/**
 * Renders the "All Locations" aggregate dashboard glance. Velocity + ranking
 * charts and the intelligence brief moved to /dashboard/analytics (design spec
 * 2026-06-19); the dashboard keeps only the glanceable zones.
 *
 * Layout:
 *  1. TopBar with aggregate title
 *  2. Aggregate KpiCards (summed values)
 *  3. PendingApprovalsStrip (links to /dashboard/reviews)
 *  4. Location KPI strip (clickable per-location cards)
 *  5. AnalyticsLinkCard (doorway to /dashboard/analytics)
 */
export function AggregateDashboardContent({ data, refresh }: Props) {
  const pendingCount = authoritativePendingCount(data);
  const hasNoData = isAggregateEmpty(data);

  return (
    <>
      <TopBar title="Dashboard" subtitle={aggregateSubtitle(data)} showLive refresh={refresh} />
      <div className="content">
        <AggregatePastDueStatus data={data} />
        <AggregateKpiState data={data} empty={hasNoData} />
        <div className="section-enter section-enter-2">
          <AgentTeamStrip scope="all" />
        </div>
        <NeedsAttentionList />
        <AggregateDashboardDoorways
          data={data}
          pendingCount={pendingCount}
          hidden={hasNoData}
        />
      </div>
    </>
  );
}

function AggregatePastDueStatus({ data }: { data: AggregateDashboardData }) {
  if (data.subscriptionStatus !== SubscriptionStatus.PAST_DUE) return null;

  return (
    <div className="section-enter section-enter-1">
      <PastDueBanner
        billingPortalUrl={nullWhenUndefined(data.billingPortalUrl)}
        pastDueAt={nullWhenUndefined(data.pastDueAt)}
        deadline={nullWhenUndefined(data.pastDueDeadline)}
        daysRemaining={nullWhenUndefined(data.daysRemaining)}
        isReadOnly={data.isReadOnly === true}
      />
      <AggregatePastDueModal data={data} />
    </div>
  );
}

function AggregatePastDueModal({ data }: { data: AggregateDashboardData }) {
  if (!data.accountId) return null;
  return (
    <PastDueModal
      accountId={data.accountId}
      daysRemaining={nullWhenUndefined(data.daysRemaining)}
      isReadOnly={data.isReadOnly === true}
      deadline={nullWhenUndefined(data.pastDueDeadline)}
    />
  );
}

function AggregateKpiState({
  data,
  empty,
}: {
  data: AggregateDashboardData;
  empty: boolean;
}) {
  if (empty) {
    return (
      <div className="aggregate-empty">
        <div className="aggregate-empty-emoji">📊</div>
        <div className="aggregate-empty-title">No reviews yet across your locations</div>
        <div className="aggregate-empty-sub">
          Once reviews start coming in, you&apos;ll see your aggregate performance metrics here.
          We&apos;ll notify you as soon as the first review arrives.
        </div>
      </div>
    );
  }

  return (
    <div className="section-enter section-enter-1">
      <AggregateKpiCards
        valueSummary={data.valueSummary}
        activeLocationCount={data.activeLocationCount}
      />
    </div>
  );
}

function AggregateDashboardDoorways({
  data,
  pendingCount,
  hidden,
}: {
  data: AggregateDashboardData;
  pendingCount: number;
  hidden: boolean;
}) {
  if (hidden) return null;

  return (
    <>
      <div className="section-enter section-enter-4">
        <PendingApprovalsStrip count={pendingCount} />
      </div>
      <div className="section-enter section-enter-5">
        <LocationKpiStrip locationKpis={data.locationKpis} />
      </div>
      <div className="section-enter section-enter-6">
        <AnalyticsLinkCard />
      </div>
    </>
  );
}

function isAggregateEmpty(data: AggregateDashboardData): boolean {
  return data.valueSummary.totalReviewsHandled === 0
    && data.recentReviews.length === 0
    && data.ranking === null;
}

function aggregateSubtitle(data: AggregateDashboardData): string {
  if (data.subscriptionStatus === SubscriptionStatus.PAST_DUE) {
    return 'Payment overdue — please update your payment method';
  }
  const locationLabel = data.activeLocationCount === 1 ? 'location' : 'locations';
  return `Welcome back — here's what's new across your ${data.activeLocationCount} ${locationLabel}.`;
}

function nullWhenUndefined<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}
