'use client';

import Link from 'next/link';
import type { DashboardData, DashboardDataActive } from '@/lib/dashboard/types';
import type { DashboardOrAggregate } from '@/hooks/useDashboardData';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { VelocityCard } from '@/components/dashboard/kpi/VelocityCard';
import { RankingCard } from '@/components/dashboard/kpi/RankingCard';
import { IntelligenceBriefCard } from '@/components/dashboard/kpi/IntelligenceBriefCard';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope } from '@/contexts/LocationContext';

/**
 * /dashboard/insights — the secondary analytics moved off the landing view
 * (PLAN.md PR2): review velocity, local ranking, and the weekly intelligence
 * brief. Gated to per-location operational data; aggregate and non-active
 * subscription shapes lack these fields, so they get a graceful pointer back.
 */
function analyticsData(data: DashboardOrAggregate): DashboardDataActive | null {
  if ('scope' in data && data.scope === 'aggregate') return null;
  const status = (data as DashboardData).subscriptionStatus;
  // Active (status undefined) and past_due both carry the analytics fields.
  if (status !== undefined && status !== 'past_due') return null;
  return data as DashboardDataActive;
}

export function InsightsContent() {
  const { currentScope } = useLocationScope();
  const { data, error, loading, refresh } = useDashboardData(currentScope);

  if (loading || !data) {
    return (
      <>
        <TopBar title="Insights" />
        <div className="content">
          <LiveRegion message="Loading your insights…" />
          <div className="dashboard-skeleton">
            <div className="skeleton-card-lg" />
            <div className="skeleton-card" />
          </div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <TopBar title="Insights" />
        <div className="content">
          <LiveRegion message={error} level="assertive" />
          <div className="card">
            <h2 className="card-h2">Unable to load insights</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 4 }}>{error}</p>
          </div>
        </div>
      </>
    );
  }

  const active = analyticsData(data);

  if (!active) {
    return (
      <>
        <TopBar title="Insights" subtitle="A deeper look at how your reputation is moving." />
        <div className="content">
          <div className="card">
            <h2 className="card-h2">Insights are per location</h2>
            <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 6, lineHeight: 1.5 }}>
              Switch to a single location to see review velocity, local ranking, and your weekly
              intelligence brief. <Link href="/dashboard" style={{ color: 'var(--rw-sage-deep)', fontWeight: 600 }}>Back to dashboard</Link>
            </p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <TopBar
        title="Insights"
        subtitle="A deeper look at how your reputation is moving. The essentials live on your dashboard."
        showLive
        refresh={refresh}
      />
      <div className="content">
        <div className="chart-row section-enter section-enter-1">
          <VelocityCard reviewVelocity={active.reviewVelocity} />
          <RankingCard ranking={active.ranking} />
        </div>
        {active.latestBrief && (
          <div className="section-enter section-enter-2">
            <IntelligenceBriefCard brief={active.latestBrief} />
          </div>
        )}
      </div>
    </>
  );
}
