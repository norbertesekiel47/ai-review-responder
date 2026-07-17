'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MarginData } from '@/lib/admin/margin-service';
import type { CostData as CostReportData } from '@/lib/admin/cost-report-service';

const PAGE_SIZE = 20;

interface CostData extends CostReportData {
  margin?: MarginData;
}

// 180/365 exercise the api_costs_daily_rollups path added in Prompt 20b —
// the API merges detail rows (<90d) with rollup rows (>=90d archived).
const DAY_OPTIONS = [7, 30, 90, 180, 365] as const;

function fmtUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function fmtPct(value: number | null): string {
  if (value == null) return '—';
  return `${value}%`;
}

type RiskLevel = 'none' | 'warning' | 'action';

function RiskBadge({ level }: { level: RiskLevel }) {
  if (level === 'action') {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700">
        Action
      </span>
    );
  }
  if (level === 'warning') {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-rw-peach/50 text-rw-brown">
        Warning
      </span>
    );
  }
  return (
    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-rw-teal/20 text-rw-teal-deep">
      OK
    </span>
  );
}

function ByProviderTable({ rows, days }: { rows: CostData['byProvider']; days: number }) {
  return (
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
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="p-4 text-center text-gray-400">
                No data
              </td>
            </tr>
          )}
          {rows.map((row) => (
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
  );
}

function ByDayTable({ rows, days }: { rows: CostData['byDay']; days: number }) {
  return (
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
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="p-4 text-center text-gray-400">
                No data
              </td>
            </tr>
          )}
          {rows.map((row) => (
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
  );
}

function ByBusinessTable({
  data,
  days,
  page,
  onPageChange,
}: {
  data: CostData;
  days: number;
  page: number;
  onPageChange: (updater: (p: number) => number) => void;
}) {
  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-700">
          By Business ({days}d): {data.byBusiness.length} businesses
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
      {data && Math.ceil(data.totalBusinesses / PAGE_SIZE) > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
          <p className="text-sm text-gray-500">
            Showing {data.offset + 1}–{Math.min(data.offset + PAGE_SIZE, data.totalBusinesses)} of {data.totalBusinesses}
          </p>
          <div className="flex gap-2">
            <button type="button"
              onClick={() => onPageChange((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40"
            >
              Prev
            </button>
            <button type="button"
              onClick={() => onPageChange((p) => p + 1)}
              disabled={page >= Math.ceil(data.totalBusinesses / PAGE_SIZE) - 1}
              className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MarginSection({ margin }: { margin: MarginData }) {
  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          Margin &amp; Gross-Margin Risk
        </h2>
        <span className="text-xs text-rw-teal font-medium tracking-wide uppercase">
          last {margin.windowDays} days
        </span>
      </div>

      {/* Platform card */}
      <div className="rounded-lg border border-rw-teal/30 bg-white p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <p className="text-sm font-semibold text-gray-700">Platform Overview</p>
            <p className="text-xs text-gray-400 mt-0.5">API/LLM variable COGS vs MRR</p>
          </div>
          <RiskBadge level={margin.platform.riskLevel} />
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Gross Margin
            </p>
            <p className={`text-2xl font-semibold ${
              margin.platform.riskLevel === 'action'
                ? 'text-red-700'
                : margin.platform.riskLevel === 'warning'
                  ? 'text-rw-brown'
                  : 'text-gray-900'
            }`}>
              {margin.platform.grossMarginPct != null
                ? `${margin.platform.grossMarginPct}%`
                : '—'}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Total Revenue (MRR)
            </p>
            <p className="text-2xl font-semibold text-gray-900">
              {fmtUsd(margin.platform.totalRevenueUsd)}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              Variable API COGS
            </p>
            <p className="text-2xl font-semibold text-gray-900">
              {fmtUsd(margin.platform.variableApiCogsUsd)}
            </p>
          </div>
        </div>

        <p className="mt-4 text-xs text-rw-teal italic">
          {margin.platform.note}
        </p>

        {/* Threshold reference */}
        <div className="mt-3 flex gap-4 text-xs text-gray-400">
          <span>
            Warning below{' '}
            <span className="font-medium text-gray-600">
              {margin.thresholds.platformWarningPct}%
            </span>
          </span>
          <span>
            Action below{' '}
            <span className="font-medium text-gray-600">
              {margin.thresholds.platformActionPct}%
            </span>
          </span>
        </div>
      </div>

      {/* Top accounts table */}
      <div className="mt-4 rounded-lg border border-rw-teal/30 bg-white">
        <div className="border-b border-gray-100 px-4 py-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">
            Top Accounts by API Cost
          </h3>
          <span className="text-xs text-gray-400">
            Warning ≥{margin.thresholds.accountWarningPct}% &nbsp;·&nbsp;
            Action ≥{margin.thresholds.accountActionPct}% of MRR
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Account</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Tier</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">MRR</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">API Cost</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Cost % MRR</th>
                <th className="px-4 py-3 text-center font-medium text-gray-500">Risk</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">$/Response</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Fallback %</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Flagged %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {margin.topAccountsByCost.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-gray-400">
                    No account cost data for this window.
                  </td>
                </tr>
              )}
              {margin.topAccountsByCost.map((row) => (
                <tr
                  key={row.accountId}
                  className={`hover:bg-gray-50 ${
                    row.riskLevel === 'action'
                      ? 'bg-red-50'
                      : row.riskLevel === 'warning'
                        ? 'bg-rw-peach/10'
                        : ''
                  }`}
                >
                  <td className="px-4 py-3 font-medium text-gray-800">
                    {row.displayName}
                  </td>
                  <td className="px-4 py-3 capitalize text-gray-600">
                    {row.subscriptionTier}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {fmtUsd(row.mrrUsd)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">
                    {fmtUsd(row.variableApiCostUsd)}
                  </td>
                  <td className={`px-4 py-3 text-right font-medium ${
                    row.riskLevel === 'action'
                      ? 'text-red-700'
                      : row.riskLevel === 'warning'
                        ? 'text-rw-brown'
                        : 'text-gray-700'
                  }`}>
                    {fmtPct(row.costPctOfMrr)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <RiskBadge level={row.riskLevel} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {row.avgCostPerResponseUsd != null
                      ? `$${row.avgCostPerResponseUsd.toFixed(4)}`
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {fmtPct(row.fallbackRatePct)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {fmtPct(row.flaggedRatePct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function CostsPage() {
  const [days, setDays] = useState<number>(7);
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, error } = useQuery<CostData>({
    queryKey: ['admin-costs', days, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        days: String(days),
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      const res = await fetch(`/api/admin/costs?${params}`);
      if (!res.ok) throw new Error(`Failed to fetch cost data: ${res.status}`);
      return res.json() as Promise<CostData>;
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="mx-auto max-w-5xl px-4 py-8">
          <p className="text-gray-500">Loading…</p>
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
              <button type="button"
                key={d}
                onClick={() => { setDays(d); setPage(0); }}
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
              Today&apos;s Platform Spend
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
          <ByProviderTable rows={data.byProvider} days={days} />
          <ByDayTable rows={data.byDay} days={days} />
        </div>

        <ByBusinessTable data={data} days={days} page={page} onPageChange={setPage} />

        {/* ── Margin & Gross-Margin Risk ─────────────────────────────────────── */}
        {data.margin && <MarginSection margin={data.margin} />}
      </div>
    </div>
  );
}
