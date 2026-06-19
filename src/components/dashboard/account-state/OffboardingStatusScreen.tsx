'use client';

import Link from 'next/link';
import {
  OffboardingStatusBanner,
  type OffboardingStatusView,
} from '@/components/dashboard/account-state/OffboardingStatusBanner';

interface OffboardingStatusScreenProps {
  activeOffboarding: OffboardingStatusView;
  accountTimeZone?: string | null;
}

export function OffboardingStatusScreen({
  activeOffboarding,
  accountTimeZone,
}: OffboardingStatusScreenProps) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" style={{ background: 'var(--rw-app-bg)' }}>
      <div className="max-w-2xl w-full rounded-lg p-8" style={{ background: 'var(--rw-card)', border: '1px solid var(--rw-hair)' }}>
        <OffboardingStatusBanner
          activeOffboarding={activeOffboarding}
          accountTimeZone={accountTimeZone}
        />
        <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--rw-app-text-muted)', textTransform: 'uppercase' }}>
              Current state
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--rw-app-text)', marginTop: 4 }}>
              {humanOffboardingState(activeOffboarding)}
            </div>
          </div>
          {activeOffboarding.status === 'failed' ? (
            <p style={{ margin: 0, color: 'var(--rw-danger)', fontSize: 14, lineHeight: 1.5 }}>
              Support has been notified and will review the failed step before processing continues.
            </p>
          ) : (
            <p style={{ margin: 0, color: 'var(--rw-app-text-muted)', fontSize: 14, lineHeight: 1.5 }}>
              RepWorth keeps this page limited to account lifecycle status. Review text,
              response drafts, provider identifiers, and business content are not shown here.
            </p>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
            <Link className="btn btn-secondary" href="/help/contact">
              Contact support
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function humanOffboardingState(active: OffboardingStatusView): string {
  if (active.status === 'failed') {
    return 'Paused for support review';
  }
  if (active.mode === 'delete_data' && active.status === 'purge_scheduled') {
    return 'Deletion waiting period';
  }
  if (active.mode === 'delete_data') return 'Deletion request processing';
  if (active.status === 'purge_scheduled') return 'Teardown scheduled';
  if (active.status === 'scheduled') return 'Cancellation scheduled';
  return 'Teardown processing';
}
