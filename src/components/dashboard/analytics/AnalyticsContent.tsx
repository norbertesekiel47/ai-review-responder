'use client';

import { useState } from 'react';
import { renderDashboardStatePanel } from '@/components/dashboard/shell/DashboardStatePanel';
import { SubscriptionUnavailableCard } from '@/components/dashboard/shell/SubscriptionUnavailableCard';
import { AnalyticsAggregateView } from '@/components/dashboard/analytics/AnalyticsAggregateView';
import { AnalyticsPerLocationView } from '@/components/dashboard/analytics/AnalyticsPerLocationView';
import { PeriodToolbar } from '@/components/dashboard/analytics/PeriodToolbar';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useSyncPendingCount } from '@/hooks/useSyncPendingCount';
import { useLocationScope } from '@/contexts/LocationContext';
import { isAggregate, perLocationActive } from '@/lib/dashboard/scope';
import {
  type DashboardWindow,
  DEFAULT_DASHBOARD_WINDOW,
} from '@/lib/kpi/types';

/**
 * /dashboard/analytics — depth, moved off the glance dashboard. Thin orchestrator:
 * resolves the shared /api/dashboard payload, handles loading/error/no-subscription,
 * then dispatches to the per-location or aggregate grid view.
 *
 * The time-range `period` (#403) is lifted here so the selection survives the
 * loading/error/data branch swap and the control stays usable mid-refetch. It is
 * threaded into useDashboardData (URL + cache key + refetch) and rendered into the
 * TopBar action slot for every branch and both scopes.
 */
export function AnalyticsContent() {
  const { currentScope } = useLocationScope();
  const [period, setPeriod] = useState<DashboardWindow>(DEFAULT_DASHBOARD_WINDOW);
  const { data, error, loading, refresh } = useDashboardData(currentScope, { window: period });
  useSyncPendingCount(data, loading);

  const periodToolbar = <PeriodToolbar value={period} onChange={setPeriod} />;

  // Loading/error scaffold (shared) keeps the period toolbar visible and usable
  // through every branch (#403). The guard also narrows `data` to non-null below.
  if (loading || error || !data) {
    return renderDashboardStatePanel('analytics', { loading, hasData: data != null, error }, periodToolbar);
  }

  if (isAggregate(data)) {
    return <AnalyticsAggregateView data={data} refresh={refresh} periodToolbar={periodToolbar} />;
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

  return <AnalyticsPerLocationView active={active} refresh={refresh} periodToolbar={periodToolbar} />;
}
