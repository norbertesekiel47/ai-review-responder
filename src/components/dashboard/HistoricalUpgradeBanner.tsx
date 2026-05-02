// src/components/dashboard/HistoricalUpgradeBanner.tsx
//
// Soft upsell rendered above the historical-period section for non-premium
// owners on the Past Replies tab. Read-only context — references future
// edit functionality without exposing it (the edit feature is parked
// pending direct GBP API approval).

import Link from 'next/link';

export function HistoricalUpgradeBanner() {
  return (
    <div className="mb-4 rounded-lg border border-[#F2C3B9]/60 bg-[#F2C3B9]/15 p-4">
      <p className="text-sm text-[#2a2a2a]">
        <strong>Premium</strong> customers will be able to edit replies to historical reviews using
        their current brand voice once direct Google integration ships.{' '}
        <Link href="/onboarding/pay" className="underline">
          See Premium plans →
        </Link>
      </p>
    </div>
  );
}
