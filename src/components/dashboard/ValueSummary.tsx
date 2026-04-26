'use client';

import type { DashboardDataActive } from '@/lib/dashboard/types';

export function ValueSummary({ valueSummary }: { valueSummary: DashboardDataActive['valueSummary'] }) {
  const timeSavedHours = Math.round((valueSummary.totalTimeSavedMinutes / 60) * 10) / 10;

  return (
    <div className="rounded-xl bg-gradient-to-r from-blue-600 to-blue-700 p-6 text-white shadow-lg">
      <p className="mb-4 text-sm font-medium text-blue-100">Since joining RepWorth</p>
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <div>
          <p className="text-3xl font-bold">{valueSummary.totalReviewsHandled}</p>
          <p className="text-sm text-blue-100">Reviews handled</p>
        </div>
        <div>
          <p className="text-3xl font-bold">{timeSavedHours}h</p>
          <p className="text-sm text-blue-100">Time saved</p>
        </div>
        <div>
          <p className="text-3xl font-bold">{valueSummary.currentResponseRate}%</p>
          <p className="text-sm text-blue-100">
            Response rate
            {valueSummary.baselineResponseRate != null && (
              <span className="ml-1">
                (was {valueSummary.baselineResponseRate}%)
              </span>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
