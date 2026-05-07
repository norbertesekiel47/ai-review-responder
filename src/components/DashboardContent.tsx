'use client';

import { useEffect, useRef, useState } from 'react';
import type { DashboardDataActive } from '@/lib/dashboard/types';
import {
  ActivePendingBusinessScreen,
  PendingAdminHandoffScreen,
  PendingPaymentScreen,
} from '@/components/dashboard/AccountStateScreens';
import { ConnectGoogleBanner } from '@/components/dashboard/ConnectGoogleBanner';
import { TopBar } from '@/components/dashboard/TopBar';
import { KpiCards } from '@/components/dashboard/KpiCards';
import { ReviewsCard } from '@/components/dashboard/ReviewsCard';
import { VelocityCard } from '@/components/dashboard/VelocityCard';
import { RankingCard } from '@/components/dashboard/RankingCard';
import { IntelligenceBriefCard } from '@/components/dashboard/IntelligenceBriefCard';
import { useDashboardData } from '@/hooks/useDashboardData';

export function DashboardContent() {
  const { data, error, refresh } = useDashboardData();
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
  }, [data]);

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

  if (!data) {
    return (
      <>
        <TopBar title="Dashboard" />
        <div className="content">
          <p style={{ textAlign: 'center', color: '#6B7280', padding: '80px 0' }}>Loading dashboard…</p>
        </div>
      </>
    );
  }

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
