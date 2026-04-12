'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CostData } from '@/app/api/admin/costs/route';

const DAY_OPTIONS = [7, 30, 90] as const;

export default function CostsPage() {
  const [days, setDays] = useState<number>(7);

  const { data, isLoading, isError, error } = useQuery<CostData>({
    queryKey: ['admin-costs', days],
    queryFn: async () => {
      const res = await fetch(`/api/admin/costs?days=${days}`);
      if (!res.ok) throw new Error(`Failed to fetch cost data: ${res.status}`);
      return res.json() as Promise<CostData>;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <p className="text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <p className="text-red-600">
            Failed to load cost data.{' '}
            {error instanceof Error ? error.message : ''}
          </p>
        </div>
      </div>
    );
  }

  const globalPct = Math.min(
    Math.round((data.todayTotalUsd / data.globalDailyLimitUsd) * 100),
    100,
  );
  const globalBarRed = globalPct >= 80;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Cost Monitoring</h1>

          {/* Day filter */}
          <div className="flex gap-2">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  days === d
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {/* Global daily progress bar */}
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex items-baseline justify-between">
            <p className="text-sm font-semibold text-gray-700">
              Today's Platform Spend
            </p>
            <p className={`text-sm font-medium ${globalBarRed ? 'text-red-700' : 'text-gray-600'}`}>
              ${data.todayTotalUsd.toFixed(2)} / ${data.globalDailyLimitUsd.toFixed(2)}
            </p>
          </div>
          <div className="mt-2 h-3 w-full rounded-full bg-gray-100">
            <div
              className={`h-3 rounded-full transition-all ${globalBarRed ? 'bg-red-500' : 'bg-blue-500'}`}
              style={{ width: `${globalPct}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-gray-400">{globalPct}% of daily limit</p>
        </div>

        {/* By Provider + By Day side by side */}
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          {/* By Provider */}
          <div className="rounded-lg border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-gray-700">By Provider ({days}d)</h2>
            </div>
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">Provider</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-500">Cost</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-500">Calls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.byProvider.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-4 text-center text-gray-400">
                      No data
                    </td>
                  </tr>
                )}
                {data.byProvider.map((row) => (
                  <tr key={row.provider} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-800 capitalize">
                      {row.provider}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700">
                      ${row.totalUsd.toFixed(4)}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-500">
                      {row.callCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* By Day */}
          <div className="rounded-lg border border-gray-200 bg-white">
            <div className="border-b border-gray-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-gray-700">By Day ({days}d)</h2>
            </div>
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-500">Date</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-500">Cost</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-500">Calls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.byDay.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-4 text-center text-gray-400">
                      No data
                    </td>
                  </tr>
                )}
                {data.byDay.map((row) => (
                  <tr key={row.day} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-700">{row.day}</td>
                    <td className="px-4 py-2 text-right text-gray-700">
                      ${row.totalUsd.toFixed(4)}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-500">
                      {row.callCount.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* By Business */}
        <div className="mt-6 rounded-lg border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-gray-700">
              By Business ({days}d) — {data.byBusiness.length} businesses
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Tier</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Period Total</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Calls</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Today</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Daily Limit</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">% of Limit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.byBusiness.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                      No business cost data found.
                    </td>
                  </tr>
                )}
                {data.byBusiness.map((row) => (
                  <tr
                    key={row.businessId}
                    className={`hover:bg-gray-50 ${row.pctOfDailyLimit >= 80 ? 'bg-red-50' : ''}`}
                  >
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {row.businessName}
                    </td>
                    <td className="px-4 py-3 capitalize text-gray-600">
                      {row.subscriptionTier}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      ${row.totalUsd.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500">
                      {row.callCount.toLocaleString()}
                    </td>
                    <td
                      className={`px-4 py-3 text-right ${
                        row.pctOfDailyLimit >= 80
                          ? 'font-medium text-red-700'
                          : 'text-gray-700'
                      }`}
                    >
                      ${row.todayUsd.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-500">
                      ${row.dailyLimitUsd.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
                          row.pctOfDailyLimit >= 80
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {row.pctOfDailyLimit}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
