'use client';

import { useEffect, useRef, useState } from 'react';
import type { DashboardDataActive, AggregateDashboardData } from '@/lib/dashboard/types';
import type { DashboardOrAggregate } from '@/hooks/useDashboardData';
import {
  ActivePendingBusinessScreen,
  PendingAdminHandoffScreen,
  PendingPaymentScreen,
} from '@/components/dashboard/AccountStateScreens';
import { CancelledBanner, PastDueBanner } from '@/components/dashboard/SubscriptionStatusBanner';
import { ConnectGoogleBanner } from '@/components/dashboard/ConnectGoogleBanner';
import { TopBar } from '@/components/dashboard/TopBar';
import { KpiCards } from '@/components/dashboard/KpiCards';
import { ReviewsCard } from '@/components/dashboard/ReviewsCard';
import { VelocityCard } from '@/components/dashboard/VelocityCard';
import { RankingCard } from '@/components/dashboard/RankingCard';
import { IntelligenceBriefCard } from '@/components/dashboard/IntelligenceBriefCard';
import { AggregateDashboardContent } from '@/components/dashboard/aggregate/AggregateDashboardContent';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useSetPendingCount } from '@/components/dashboard/PendingCountContext';
import { useLocationScope } from '@/contexts/LocationContext';

export function DashboardContent() {
  const { currentScope, setLocationScope } = useLocationScope();
  const { data, error, loading, refresh, scopeFallback } = useDashboardData(
    currentScope,
    {
      // VAL-DASH-029: When the API detects the selected location is archived,
      // fall back to primary and update the LocationContext switcher.
      onScopeFallback: (fallback) => {
        setLocationScope(fallback.fallbackLocationId as import('@/lib/shared/ids').LocationId);
      },
    },
  );
  const setPendingCount = useSetPendingCount();
  const reviewsRef = useRef<HTMLDivElement | null>(null);
  const [initialTab, setInitialTab] = useState<'needs' | 'all'>('needs');

  // OQ-3 — read URL hash on mount; auto-select Needs Action + scroll into view.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === '#needs-action') {
      setInitialTab('needs');
      // Defer until layout settles.
      setTimeout(() => {
        if (reviewsRef.current) {
          const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push pending count to the layout-scoped context so MobileTabBar's "Needs
  // Action" tab can show a red badge on every authenticated route.
  const pendingFromData = computePendingCount(data);
  useEffect(() => {
    setPendingCount(pendingFromData);
  }, [pendingFromData, setPendingCount]);

  if (error) {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <div className="card" style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }}>
            <h2 className="card-h2" style={{ color: '#991B1B' }}>Error</h2>
            <p style={{ fontSize: 14, color: '#B91C1C', marginTop: 4 }}>{error}</p>
          </div>
        </div>
      </>
    );
  }

  // VAL-DASH-025: Loading state with skeleton/spinner
  if (loading || !data) {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <div className="dashboard-skeleton">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              <div className="skeleton-card" />
              <div className="skeleton-card" />
              <div className="skeleton-card" />
            </div>
            <div className="skeleton-card-lg" />
            <div className="skeleton-card-lg" />
          </div>
        </div>
      </>
    );
  }

  // Aggregate view: scope === 'all'
  if (isAggregateData(data)) {
    return <AggregateDashboardContent data={data} refresh={refresh} />;
  }

  // Non-active subscription states (per-location only)
  if (data.subscriptionStatus === 'active_pending_business') {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <ActivePendingBusinessScreen />
        </div>
      </>
    );
  }

  if (data.subscriptionStatus === 'pending_payment_admin_handoff') {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <PendingAdminHandoffScreen />
        </div>
      </>
    );
  }

  if (data.subscriptionStatus === 'pending_payment') {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <PendingPaymentScreen data={data} />
        </div>
      </>
    );
  }

  // VAL-CROSS-011: Cancelled account — read-only banner, write actions disabled
  if (data.subscriptionStatus === 'cancelled') {
    const cancelledData = data as import('@/lib/dashboard/types').DashboardDataCancelled;
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <CancelledBanner
            businessName={cancelledData.businessName}
            gracePeriodEndDate={cancelledData.gracePeriodEndDate}
            readAccess={cancelledData.readAccess}
          />
          {/* Read access is still available during grace period */}
          {cancelledData.readAccess && (
            <div className="sub-status-banner__readonly-notice" style={{
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid #E5E7EB',
              background: '#F9FAFB',
              marginBottom: 14,
              fontSize: 13,
              color: '#6B7280',
            }}>
              You can still view your reviews and past replies, but all write actions are disabled.
            </div>
          )}
        </div>
      </>
    );
  }

  // VAL-CROSS-012: Past-due account — payment warning banner, features continue
  if (data.subscriptionStatus === 'past_due') {
    const pastDueData = data as import('@/lib/dashboard/types').DashboardDataPastDue;
    return (
      <>
        <TopBar title="Dashboard" subtitle="Payment overdue — please update your payment method" />
        <div className="content">
          <PastDueBanner
            businessName={pastDueData.businessName}
            billingPortalUrl={pastDueData.billingPortalUrl}
          />
          {/* During past_due grace period, dashboard features still work */}
        </div>
      </>
    );
  }

  // Active per-location view (same as before redesign)
  const activeData: DashboardDataActive = data;
  const { valueSummary, reviewVelocity, ranking, recentReviews, latestBrief, zernioConnection, business } = activeData;
  const pending = recentReviews.filter((r) => (r.responseStatus ?? r.status) === 'pending_approval').length;

  function scrollToReviews() {
    if (reviewsRef.current) {
      const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }

  const subtitle = business.name
    ? `Welcome back — here's what's new for ${business.name}.`
    : "Welcome back — here's what's new.";

  return (
    <>
      <TopBar title="Dashboard" subtitle={subtitle} showLive refresh={refresh} />
      <div className="content">
        <div className="section-enter section-enter-1">
          <ConnectGoogleBanner zernio={zernioConnection} />
        </div>
        <div className="section-enter section-enter-2">
          <KpiCards valueSummary={valueSummary} pendingCount={pending} onScrollToReviews={scrollToReviews} />
        </div>
        <div className="section-enter section-enter-3">
          <ReviewsCard recentReviews={recentReviews} onActionSuccess={() => { void refresh(); }} ref={reviewsRef} initialTab={initialTab} />
        </div>
        <div className="section-enter section-enter-4">
          <VelocityCard reviewVelocity={reviewVelocity} />
        </div>
        <div className="section-enter section-enter-5">
          <RankingCard ranking={ranking} />
        </div>
        {latestBrief && (
          <div className="section-enter section-enter-6">
            <IntelligenceBriefCard brief={latestBrief} />
          </div>
        )}
      </div>
    </>
  );
}

/** Type guard to distinguish AggregateDashboardData from per-location DashboardData. */
function isAggregateData(data: DashboardOrAggregate): data is AggregateDashboardData {
  return 'scope' in data && data.scope === 'aggregate';
}

/** Compute pending approval count from either aggregate or per-location data. */
function computePendingCount(data: DashboardOrAggregate | null): number {
  if (!data) return 0;
  if (isAggregateData(data)) {
    return data.recentReviews.filter(
      (r) => (r.responseStatus ?? r.status) === 'pending_approval',
    ).length;
  }
  if (data.subscriptionStatus === undefined) {
    return data.recentReviews.filter(
      (r) => (r.responseStatus ?? r.status) === 'pending_approval',
    ).length;
  }
  return 0;
}
