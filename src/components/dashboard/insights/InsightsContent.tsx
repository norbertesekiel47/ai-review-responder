'use client';

import Link from 'next/link';
import type { DashboardDataActive, AggregateDashboardData } from '@/lib/dashboard/types';
import type { DashboardOrAggregate } from '@/hooks/useDashboardData';
import type { LocationId } from '@/lib/shared/ids';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { useDashboardData } from '@/hooks/useDashboardData';
import { useLocationScope } from '@/contexts/LocationContext';
import { TopBar } from '@/components/dashboard/shell/TopBar';
import { LiveRegion } from '@/components/ui/LiveRegion';
import { VelocityCard } from '@/components/dashboard/kpi/VelocityCard';
import { RankingCard } from '@/components/dashboard/kpi/RankingCard';
import { IntelligenceBriefCard } from '@/components/dashboard/kpi/IntelligenceBriefCard';
import { ActivePendingBusinessScreen } from '@/components/dashboard/account-state/AccountStateScreens';
import { PendingAdminHandoffScreen } from '@/components/dashboard/account-state/PendingAdminHandoffScreen';
import { PendingPaymentScreen } from '@/components/dashboard/account-state/PendingPaymentScreen';
import { CancelledBanner } from '@/components/dashboard/account-state/SubscriptionStatusBanner';

const RIGHT_LINK = { href: '/dashboard', label: 'Back to dashboard' };
const SUBTITLE = 'Review velocity, search ranking, and your latest brief.';

/** Aggregate shape lacks per-location analytics (latestBrief etc.). */
function isAggregate(data: DashboardOrAggregate): data is AggregateDashboardData {
  return 'scope' in data && data.scope === 'aggregate';
}

// Per-location analytics drill-down. Reuses the dashboard's data path and the
// same account-state screens, so non-active / aggregate shapes degrade
// gracefully instead of crashing on a missing field. Does NOT opt into the
// reputation metric batch — insights only needs the base dashboard payload.
export function InsightsContent() {
  const { currentScope, setLocationScope } = useLocationScope();
  const { data, error, loading, refresh } = useDashboardData(currentScope, {
    onScopeFallback: (fallback) => {
      setLocationScope(fallback.fallbackLocationId as LocationId);
    },
  });

  if (error) {
    return (
      <Shell>
        <LiveRegion message={error} level="assertive" />
        <div className="card" style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }}>
          <h2 className="card-h2" style={{ color: '#991B1B' }}>Error</h2>
          <p style={{ fontSize: 14, color: '#B91C1C', marginTop: 4 }}>{error}</p>
          <Link href="/help/contact" style={{ display: 'inline-block', fontSize: 14, marginTop: 10, color: '#1D4ED8' }}>
            Contact support
          </Link>
        </div>
      </Shell>
    );
  }

  if (loading || !data) {
    return (
      <Shell>
        <LiveRegion message="Loading your insights…" />
        <div className="dashboard-skeleton">
          <div className="skeleton-card-lg" />
          <div className="skeleton-card-lg" />
        </div>
      </Shell>
    );
  }

  // Aggregate ("All Locations"): insights are per-location only.
  if (isAggregate(data)) {
    return (
      <Shell refresh={refresh}>
        <div className="card">
          <h2 className="card-h2">Insights are shown per location</h2>
          <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', lineHeight: 1.5 }}>
            Choose a single location from the switcher to see its review velocity, search ranking,
            and latest intelligence brief.
          </p>
        </div>
      </Shell>
    );
  }

  // Non-active account states reuse the dashboard's screens.
  if (data.subscriptionStatus === 'active_pending_business') {
    return <Shell><ActivePendingBusinessScreen /></Shell>;
  }
  if (data.subscriptionStatus === 'pending_payment_admin_handoff') {
    return <Shell><PendingAdminHandoffScreen /></Shell>;
  }
  if (data.subscriptionStatus === SubscriptionStatus.PENDING_PAYMENT) {
    return <Shell><PendingPaymentScreen data={data} /></Shell>;
  }
  if (data.subscriptionStatus === SubscriptionStatus.CANCELLED) {
    const cancelled = data as import('@/lib/dashboard/types').DashboardDataCancelled;
    return (
      <Shell>
        <CancelledBanner gracePeriodEndDate={cancelled.gracePeriodEndDate} readAccess={cancelled.readAccess} />
      </Shell>
    );
  }

  // Active or past_due — both carry the per-location analytics fields.
  const analytics = data as DashboardDataActive;
  return (
    <Shell refresh={refresh}>
      <div className="section-enter section-enter-1">
        <VelocityCard reviewVelocity={analytics.reviewVelocity} />
      </div>
      <div className="section-enter section-enter-2">
        <RankingCard ranking={analytics.ranking} />
      </div>
      {analytics.latestBrief && (
        <div className="section-enter section-enter-3">
          <IntelligenceBriefCard brief={analytics.latestBrief} />
        </div>
      )}
    </Shell>
  );
}

/** Standard page shell for insights — TopBar (live + back link) + content wrapper. */
function Shell({ children, refresh }: { children: React.ReactNode; refresh?: () => void | Promise<void> }) {
  return (
    <>
      <TopBar
        title="Insights"
        subtitle={SUBTITLE}
        showLive={refresh != null}
        refresh={refresh}
        rightLink={RIGHT_LINK}
      />
      <div className="content">{children}</div>
    </>
  );
}
