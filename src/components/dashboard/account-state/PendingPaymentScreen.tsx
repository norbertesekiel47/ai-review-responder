'use client';

import type { DashboardDataPendingPayment } from '@/lib/dashboard/types';

export function PendingPaymentScreen({ data }: { data: DashboardDataPendingPayment }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--rw-app-bg)' }}>
      <div className="max-w-md w-full rounded-lg p-8 text-center" style={{ background: 'var(--rw-card)', border: '1px solid var(--rw-hair)' }}>
        <h1 className="text-2xl font-bold mb-4">Your subscription isn&apos;t active yet</h1>
        <p className="mb-6" style={{ color: 'var(--rw-app-text-muted)' }}>Complete your payment to unlock automated review responses.</p>
        {/* The CTA target is the SERVER's decision (`resolveFunnelEntry`), not
            a hardcoded /onboarding/pay: an owner owed the pre-pay demo is sent
            there instead of the paywall, and the browser never needs to know
            the demo flag's state (invariant #13). */}
        {data.funnelUrl ? (
          <a
            href={data.funnelUrl}
            className="btn btn-primary"
          >
            Pay now
          </a>
        ) : (
          <p className="text-sm" style={{ color: 'var(--rw-danger)' }}>Payment link unavailable. Contact support.</p>
        )}
      </div>
    </div>
  );
}
