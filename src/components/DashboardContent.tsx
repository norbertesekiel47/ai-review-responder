'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DashboardData, DashboardDataActive } from '@/lib/dashboard/types';
import {
  ActivePendingBusinessScreen,
  PendingAdminHandoffScreen,
  PendingPaymentScreen,
} from '@/components/dashboard/AccountStateScreens';
import { ValueSummary } from '@/components/dashboard/ValueSummary';
import { ReviewVelocityChart, RankingChart } from '@/components/dashboard/Charts';
import { ReviewsList } from '@/components/dashboard/ReviewsList';

export function DashboardContent() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const json: DashboardData = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="rounded-lg border border-red-300 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-800">Error</h2>
          <p className="mt-1 text-sm text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500">Loading dashboard...</p>
      </div>
    );
  }

  if (data.subscriptionStatus === 'active_pending_business') {
    return <ActivePendingBusinessScreen />;
  }

  if (data.subscriptionStatus === 'pending_payment_admin_handoff') {
    return <PendingAdminHandoffScreen />;
  }

  if (data.subscriptionStatus === 'pending_payment') {
    return <PendingPaymentScreen data={data} />;
  }

  const activeData: DashboardDataActive = data;
  const { valueSummary, reviewVelocity, ranking, recentReviews, latestBrief } = activeData;

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      {/* Section A: Value Summary Banner */}
      <ValueSummary valueSummary={valueSummary} />

      {/* Section B: Review Velocity Chart */}
      <ReviewVelocityChart reviewVelocity={reviewVelocity} />

      {/* Section C: Ranking Chart */}
      <RankingChart ranking={ranking} />

      {/* Section D: Recent Reviews */}
      <ReviewsList recentReviews={recentReviews} onActionSuccess={fetchDashboard} />

      {/* Section E: Latest Intelligence Brief */}
      {latestBrief && (
        <div className="rounded-lg border-l-4 border-blue-500 bg-blue-50 p-6">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-lg font-semibold text-gray-900">Intelligence Brief</h2>
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              {latestBrief.type === 'monthly' ? 'Monthly' : 'Weekly'}
            </span>
          </div>
          <p className="mb-2 text-xs text-gray-500">{latestBrief.periodLabel}</p>
          <p className="whitespace-pre-line text-sm text-gray-700">{latestBrief.text}</p>
        </div>
      )}
    </div>
  );
}
