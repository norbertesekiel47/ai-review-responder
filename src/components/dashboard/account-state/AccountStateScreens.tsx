'use client';

import Link from 'next/link';

export { OffboardingStatusScreen } from './OffboardingStatusScreen';

export function ActivePendingBusinessScreen() {
  return (
    <div className="account-state-screen">
      <section className="card account-state-card account-state-card--compact">
        <h1 className="account-state-title">Set up your business</h1>
        <p className="account-state-copy">
          Your subscription is active. Just one more step: tell us about
          your business so we can start fetching reviews.
        </p>
        <Link
          href="/onboarding/business"
          className="btn btn-primary"
        >
          Set up business
        </Link>
      </section>
    </div>
  );
}
