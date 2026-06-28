'use client';

import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { SubscriptionUnavailableCard } from '@/components/dashboard/shell/SubscriptionUnavailableCard';
import { AnalyticsAggregateView } from '@/components/dashboard/analytics/AnalyticsAggregateView';
import { AnalyticsPerLocationView } from '@/components/dashboard/analytics/AnalyticsPerLocationView';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useSyncPendingCount } from '@/hooks/useSyncPendingCount';
import { useLocationScope } from '@/contexts/LocationContext';
import { isAggregate, perLocationActive } from '@/lib/dashboard/scope';

/**
 * /dashboard/analytics — depth, moved off the glance dashboard. Thin orchestrator:
 * resolves the shared /api/dashboard payload, handles loading/error/no-subscription,
 * then dispatches to the per-location or aggregate grid view.
 */
export function AnalyticsContent() {
  const { currentScope } = useLocationScope();
  const { data, error, loading, refresh } = useDashboardData(currentScope);
  useSyncPendingCount(data, loading);

  if (loading || !data) {
    return (
      <>
        <TopBar title="Analytics" />
        <div className="content content--analytics">
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
        <div className="content content--analytics">
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
    return <AnalyticsAggregateView data={data} refresh={refresh} />;
  }

  const active = perLocationActive(data);
  if (!active) {
    return (
      <SubscriptionUnavailableCard
        topBarTitle="Analytics"
        heading="Analytics aren't available right now"
        body="Your account needs an active subscription to see reputation analytics."
      />
    );
  }

  return <AnalyticsPerLocationView active={active} refresh={refresh} />;
}
