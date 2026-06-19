'use client';

import Link from 'next/link';

export { OffboardingStatusScreen } from './OffboardingStatusScreen';

export function ActivePendingBusinessScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'var(--rw-app-bg)' }}>
      <div className="max-w-md w-full rounded-lg p-8 text-center" style={{ background: 'var(--rw-card)', border: '1px solid var(--rw-hair)' }}>
        <h1 className="text-2xl font-bold mb-4">Set up your business</h1>
        <p className="mb-6" style={{ color: 'var(--rw-app-text-muted)' }}>
          Your subscription is active. Just one more step: tell us about
          your business so we can start fetching reviews.
        </p>
        <Link
          href="/onboarding/business"
          className="btn btn-primary"
        >
          Set up business
        </Link>
      </div>
    </div>
  );
}
