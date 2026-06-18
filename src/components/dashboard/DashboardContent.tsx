'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { redirect } from 'next/navigation';
import type { DashboardDataActive, DashboardDataPastDue, AggregateDashboardData } from '@/lib/dashboard/types';
import type { DashboardOrAggregate } from '@/hooks/useDashboardData';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  ActivePendingBusinessScreen,
} from '@/components/dashboard/account-state/AccountStateScreens';
import type { OffboardingStatusView } from '@/components/dashboard/account-state/OffboardingStatusBanner';
import { ACCOUNT_OFFBOARDING_STATUS_PATH } from '@/lib/shared/request-path-header';
import { PendingAdminHandoffScreen } from '@/components/dashboard/account-state/PendingAdminHandoffScreen';
import { PendingPaymentScreen } from '@/components/dashboard/account-state/PendingPaymentScreen';
import { CancelledBanner, PastDueBanner } from '@/components/dashboard/account-state/SubscriptionStatusBanner';
import { PastDueModal } from '@/components/dashboard/account-state/PastDueModal';
import { ConnectGoogleBanner } from '@/components/dashboard/account-state/ConnectGoogleBanner';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';
import { ReputationHeroBand } from '@/components/dashboard/reputation/ReputationHeroBand';
import { PendingApprovalsStrip } from '@/components/dashboard/reputation/PendingApprovalsStrip';
import { ReputationTrendChart } from '@/components/dashboard/reputation/ReputationTrendChart';
import { AggregateDashboardContent } from '@/components/dashboard/aggregate/AggregateDashboardContent';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useSetPendingCount } from '@/contexts/PendingCountContext';
import { useLocationScope } from '@/contexts/LocationContext';
import { useNeedsActionHashScroll } from '@/hooks/useNeedsActionHashScroll';

export function DashboardContent({ pastRepliesEnabled = false }: { pastRepliesEnabled?: boolean }) {
  const setPendingCount = useSetPendingCount();
  const {
    data: offboardingStatus,
    error: offboardingError,
    isLoading: offboardingLoading,
  } = useQuery({
    queryKey: ['account-offboarding-status', 'dashboard-gate'],
    queryFn: fetchAccountOffboardingStatus,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });

  const blockedOffboarding = offboardingStatus?.enabled
    && offboardingStatus.activeOffboarding?.operationalUIBlocked
    ? offboardingStatus.activeOffboarding
    : null;

  useEffect(() => {
    if (blockedOffboarding) {
      setPendingCount(0);
    }
  }, [blockedOffboarding, setPendingCount]);

  if (offboardingLoading) {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <LiveRegion message="Loading your dashboard…" />
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

  if (offboardingError) {
    const message = offboardingError instanceof Error
      ? offboardingError.message
      : 'Unable to load account status';
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <LiveRegion message={message} level="assertive" />
          <div className="card" style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }}>
            <h2 className="card-h2" style={{ color: '#991B1B' }}>Unable to verify account status</h2>
            <p style={{ fontSize: 14, color: '#B91C1C', marginTop: 4 }}>{message}</p>
            <Link
              href="/help/contact"
              style={{ display: 'inline-block', fontSize: 14, marginTop: 10, color: '#1D4ED8' }}
            >
              Contact support
            </Link>
          </div>
        </div>
      </>
    );
  }

  if (blockedOffboarding) {
    redirect(ACCOUNT_OFFBOARDING_STATUS_PATH);
    return (
      <div className="content">
        <LiveRegion message="Opening account status..." />
        <div className="dashboard-skeleton">
          <div className="skeleton-card-lg" />
          <div className="skeleton-card" />
        </div>
      </div>
    );
  }

  return <DashboardOperationalContent pastRepliesEnabled={pastRepliesEnabled} />;
}

type OffboardingStatusResponse = {
  enabled: boolean;
  accountTimeZone?: string | null;
  activeOffboarding: OffboardingStatusView | null;
};

function DashboardOperationalContent({ pastRepliesEnabled }: { pastRepliesEnabled: boolean }) {
  const { currentScope, setLocationScope } = useLocationScope();
  const { data, error, loading, refresh, scopeFallback } = useDashboardData(
    currentScope,
    {
      // The dashboard landing is the only consumer that opts into the
      // reputation/hero metric batch (?metrics=reputation).
      includeReputationMetrics: true,
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

  useNeedsActionHashScroll(reviewsRef, () => setInitialTab('needs'));

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
          <LiveRegion message={error} level="assertive" />
          <div className="card" style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }}>
            <h2 className="card-h2" style={{ color: '#991B1B' }}>Error</h2>
            <p style={{ fontSize: 14, color: '#B91C1C', marginTop: 4 }}>{error}</p>
            <Link
              href="/help/contact"
              style={{ display: 'inline-block', fontSize: 14, marginTop: 10, color: '#1D4ED8' }}
            >
              Contact support
            </Link>
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
          <LiveRegion message="Loading your dashboard…" />
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

  if (data.subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT) {
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
  if (data.subscriptionStatus === SubscriptionStatus.CANCELLED) {
    const cancelledData = data as import('@/lib/dashboard/types').DashboardDataCancelled;
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <CancelledBanner
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

  // Active per-location view — redesigned 4-zone layout (single-location).
  // The demoted analytics (Velocity/Ranking/Brief) now live on /dashboard/insights.
  const pastDueData: DashboardDataPastDue | null =
    data.subscriptionStatus === SubscriptionStatus.PAST_DUE ? data : null;
  const activeData: DashboardDataActive = data as DashboardDataActive;
  const { recentReviews, zernioConnection, business, reputationSummary } = activeData;
  // Authoritative pending count: the SQL reputation count when present (same
  // source as the tabbar badge), else the recentReviews-derived fallback.
  const pendingCount =
    reputationSummary?.pendingApprovalCount ??
    recentReviews.filter((r) => (r.responseStatus ?? r.status) === 'pending_approval').length;

  function scrollToReviews() {
    if (reviewsRef.current) {
      const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  }

  const activeSubtitle = business.name
    ? `Welcome back — here's what's new for ${business.name}.`
    : "Welcome back — here's what's new.";
  const subtitle = pastDueData
    ? 'Payment overdue — please update your payment method'
    : activeSubtitle;
  const readOnly = pastDueData?.isReadOnly ?? false;

  return (
    <>
      <TopBar title="Dashboard" subtitle={subtitle} showLive refresh={refresh} />
      <div className="content">
        {pastDueData && (
          <div className="section-enter section-enter-1">
            <PastDueBanner
              billingPortalUrl={pastDueData.billingPortalUrl}
              pastDueAt={pastDueData.pastDueAt}
              deadline={pastDueData.pastDueDeadline}
              daysRemaining={pastDueData.daysRemaining}
              isReadOnly={pastDueData.isReadOnly}
            />
            <PastDueModal
              accountId={pastDueData.accountId}
              daysRemaining={pastDueData.daysRemaining}
              isReadOnly={pastDueData.isReadOnly}
              deadline={pastDueData.pastDueDeadline}
            />
          </div>
        )}
        <div className="section-enter section-enter-1">
          <ConnectGoogleBanner zernio={zernioConnection} readOnly={readOnly} />
        </div>
        {/* Zone 1 — reputation/ROI hero (the single dominant zone). */}
        {reputationSummary && (
          <div className="section-enter section-enter-2">
            <ReputationHeroBand summary={reputationSummary} />
          </div>
        )}
        {/* Zone 2 — pending-approvals action strip (strong secondary). */}
        <div className="section-enter section-enter-3">
          <PendingApprovalsStrip pendingCount={pendingCount} onReview={scrollToReviews} />
        </div>
        {/* Zone 3 — Needs-Action reviews ("All Recent" demoted to a link). */}
        <div className="section-enter section-enter-4">
          <ReviewsCard
            recentReviews={recentReviews}
            onActionSuccess={() => { void refresh(); }}
            ref={reviewsRef}
            initialTab={initialTab}
            readOnly={readOnly}
            viewAllHref={pastRepliesEnabled ? '/dashboard/past-replies' : undefined}
          />
        </div>
        {/* Zone 4 — reputation trend (star-equivalent). */}
        {reputationSummary && (
          <div className="section-enter section-enter-5">
            <ReputationTrendChart trend={reputationSummary.sentimentTrend} />
          </div>
        )}
        {/* Contextual entry to the demoted analytics. */}
        <Link href="/dashboard/insights" className="reviews-view-all">
          View insights →
        </Link>
      </div>
    </>
  );
}

async function fetchAccountOffboardingStatus(): Promise<OffboardingStatusResponse> {
  const res = await fetch('/api/account/offboarding/status', {
    headers: { Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.detail ?? body.error ?? 'Unable to load account status');
  }
  return body as OffboardingStatusResponse;
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
  if (data.subscriptionStatus === undefined || data.subscriptionStatus === SubscriptionStatus.PAST_DUE) {
    // Prefer the authoritative SQL count (flagged-excluded) when the landing
    // opted into reputation metrics; fall back to the recentReviews-derived count.
    if ('reputationSummary' in data && data.reputationSummary) {
      return data.reputationSummary.pendingApprovalCount;
    }
    return data.recentReviews.filter(
      (r) => (r.responseStatus ?? r.status) === 'pending_approval',
    ).length;
  }
  return 0;
}
