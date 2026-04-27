'use client';

import Link from 'next/link';
import type { DashboardDataPendingPayment } from '@/lib/dashboard/types';

export function ActivePendingBusinessScreen() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Set up your business</h1>
        <p className="text-gray-700 mb-6">
          Your subscription is active. Just one more step — tell us about
          your business so we can start fetching reviews.
        </p>
        <Link
          href="/onboarding/business"
          className="inline-block bg-blue-600 text-white font-medium py-3 px-8 rounded-md hover:bg-blue-700"
        >
          Set up business
        </Link>
      </div>
    </div>
  );
}

export function PendingAdminHandoffScreen() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Account activation pending</h1>
        <p className="text-gray-700">
          Your RepWorth account is being set up by your account manager.
          You&apos;ll receive an email when it&apos;s ready.
        </p>
      </div>
    </div>
  );
}

export function PendingPaymentScreen({ data }: { data: DashboardDataPendingPayment }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Your subscription isn&apos;t active yet</h1>
        <p className="text-gray-700 mb-6">Complete your payment to unlock automated review responses.</p>
        {data.paymentUrl ? (
          <a
            href={data.paymentUrl}
            className="inline-block bg-blue-600 text-white font-medium py-3 px-8 rounded-md hover:bg-blue-700"
          >
            Pay now
          </a>
        ) : (
          <p className="text-sm text-red-600">Payment link unavailable. Contact support.</p>
        )}
      </div>
    </div>
  );
}
