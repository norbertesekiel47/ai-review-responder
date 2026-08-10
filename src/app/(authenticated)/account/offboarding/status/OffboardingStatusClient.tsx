'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { OffboardingStatusScreen } from '@/components/dashboard/account-state/AccountStateScreens';
import type { OffboardingStatusView } from '@/components/dashboard/account-state/OffboardingStatusBanner';
import { LiveRegion } from '@/components/ui/LiveRegion';

type OffboardingStatusResponse = {
  enabled: boolean;
  accountTimeZone?: string | null;
  activeOffboarding: OffboardingStatusView | null;
};

export function OffboardingStatusClient() {
  const {
    data,
    error,
    isLoading,
  } = useQuery({
    queryKey: ['account-offboarding-status', 'status-page'],
    queryFn: fetchAccountOffboardingStatus,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });

  if (isLoading) {
    return (
      <div className="content">
        <LiveRegion message="Loading account status..." />
        <div className="dashboard-skeleton">
          <div className="skeleton-card-lg" />
          <div className="skeleton-card" />
        </div>
      </div>
    );
  }

  if (error) {
    const message = error instanceof Error ? error.message : 'Unable to load account status';
    return (
      <div className="content">
        <LiveRegion message={message} level="assertive" />
        <div className="card" style={{ borderColor: 'var(--rw-danger)', background: 'var(--rw-danger-soft)' }}>
          <h2 className="card-h2" style={{ color: 'var(--rw-danger)' }}>Unable to load account status</h2>
          <p style={{ fontSize: 14, color: 'var(--rw-danger)', marginTop: 4 }}>{message}</p>
          <Link
            href="/help/contact"
            style={{ display: 'inline-block', fontSize: 14, marginTop: 10, color: 'var(--rw-sage-deep)' }}
          >
            Contact support
          </Link>
        </div>
      </div>
    );
  }

  const active = data?.activeOffboarding ?? null;
  const accountTimeZone = data?.accountTimeZone ?? 'UTC';

  return (
    <div className="content">
      {data?.enabled && active?.operationalUIBlocked ? (
        <OffboardingStatusScreen
          activeOffboarding={active}
          accountTimeZone={accountTimeZone}
        />
      ) : (
        <div className="account-state-screen">
          <section className="card account-state-card account-state-card--compact">
            <h1 className="account-state-title">No account teardown in progress</h1>
            <p className="account-state-copy">
              Your account does not have an active deletion or teardown status to show.
            </p>
            <Link className="btn btn-primary" href="/dashboard">
              Return to dashboard
            </Link>
          </section>
        </div>
      )}
    </div>
  );
}

async function fetchAccountOffboardingStatus(): Promise<OffboardingStatusResponse> {
  const res = await fetch('/api/account/offboarding/status', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? body.error ?? 'Unable to load account status');
  }
  return res.json() as Promise<OffboardingStatusResponse>;
}
