'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MarginData } from '@/lib/admin/margin-service';
import type { CostData as CostReportData } from '@/lib/admin/cost-report-service';
import { StatTile } from '@/components/admin/ui/StatTile';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminCount, formatAdminDate } from '@/components/admin/ui/format';

import { COSTS_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';
const DEFAULT_DAYS = 30;

interface CostData extends CostReportData {
  margin: MarginData | null;
}

type ByBusinessRow = CostData['byBusiness'][number];
type AccountMarginRow = MarginData['topAccountsByCost'][number];

// 180/365 exercise the api_costs_daily_rollups path added in Prompt 20b —
// the API merges detail rows (<90d) with rollup rows (>=90d archived).
const DAY_OPTIONS = [7, 30, 90, 180, 365] as const;

/**
 * ONE money precision on this page (X20): cents. The provider/day tables used
 * to print four decimals beside two-decimal totals, so the same $12.50 read as
 * two different numbers one column apart.
 */
function fmtUsd(value: number | null): string {
  if (value == null) return '—';
  return `$${value.toFixed(2)}`;
}

function fmtPct(value: number | null): string {
  if (value == null) return '—';
  return `${value}%`;
}

/** The daily-limit share above which a business's spend is called out. */
const DAILY_LIMIT_HOT_PCT = 80;

// Two constants rather than one ternary inside a className: no single class
// string mixes a coloured background with gray text.
const PCT_OF_LIMIT_HOT = 'bg-red-100 text-red-700';
const PCT_OF_LIMIT_OK = 'bg-gray-100 text-gray-600';

// Shared shape of the By-Provider and By-Day mini tables — same three columns
// (name, cost, calls), differing only in the row identity/label and the
// first-column styling. Kept local: single file, two call sites below.
function CostMiniTable<T>({
  title,
  columnLabel,
  days,
  rows,
  rowKey,
  primaryLabel,
  primaryClassName,
  totalUsd,
  callCount,
}: {
  title: string;
  columnLabel: string;
  days: number;
  rows: T[];
  rowKey: (row: T) => string;
  primaryLabel: (row: T) => string;
  primaryClassName: string;
  totalUsd: (row: T) => number;
  callCount: (row: T) => number;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-700">{title} ({days}d)</h2>
      </div>
      <table className="min-w-full divide-y divide-gray-100 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2 text-left font-medium text-gray-500">{columnLabel}</th>
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
            <tr key={rowKey(row)} className="hover:bg-gray-50">
              <td className={`px-4 py-2 ${primaryClassName}`}>{primaryLabel(row)}</td>
              <td className="px-4 py-2 text-right text-gray-700">{fmtUsd(totalUsd(row))}</td>
              <td className="px-4 py-2 text-right text-gray-500">{formatAdminCount(callCount(row))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function byBusinessColumns(days: number): DataTableColumn<ByBusinessRow>[] {
  return [
    {
      key: 'business',
      header: 'Business',
      render: (row) => <span className="font-medium text-gray-800">{row.businessName}</span>,
      sortValue: (row) => row.businessName,
    },
    {
      key: 'tier',
      header: 'Tier',
      render: (row) => <StatusBadge vocab="tier" value={row.subscriptionTier} />,
    },
    {
      key: 'total',
      header: `Period Total (${days}d)`,
      className: 'text-right',
      render: (row) => fmtUsd(row.totalUsd),
      sortValue: (row) => row.totalUsd,
    },
    {
      key: 'calls',
      header: 'Calls',
      className: 'text-right',
      render: (row) => formatAdminCount(row.callCount),
      sortValue: (row) => row.callCount,
    },
    {
      key: 'today',
      header: 'Today',
      className: 'text-right',
      render: (row) => (
        <span className={row.pctOfDailyLimit >= DAILY_LIMIT_HOT_PCT ? 'font-medium text-red-700' : 'text-gray-700'}>
          {fmtUsd(row.todayUsd)}
        </span>
      ),
      sortValue: (row) => row.todayUsd,
    },
    {
      key: 'dailyLimit',
      header: 'Daily Limit',
      className: 'text-right',
      render: (row) => fmtUsd(row.dailyLimitUsd),
    },
    {
      key: 'pctOfLimit',
      header: '% of Limit',
      className: 'text-right',
      render: (row) => (
        <span
          className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${
            row.pctOfDailyLimit >= DAILY_LIMIT_HOT_PCT ? PCT_OF_LIMIT_HOT : PCT_OF_LIMIT_OK
          }`}
        >
          {row.pctOfDailyLimit}%
        </span>
      ),
      sortValue: (row) => row.pctOfDailyLimit,
    },
  ];
}

function MarginSection({ margin }: { margin: MarginData }) {
  // The three ratio columns ($/Response, Fallback %, Flagged %) are diagnostic
  // depth, not the triage read (X19): nine numeric columns hid the Risk column
  // that the table exists for. They stay one click away.
  const [showRatios, setShowRatios] = useState(false);
  const columnCount = showRatios ? 9 : 6;
  return (
    <div className="mt-8">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Margin &amp; Gross-Margin Risk</h2>
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
          last {margin.windowDays} days
        </span>
      </div>

      {/* Platform card */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-700">Platform Overview</p>
            <p className="mt-0.5 text-xs text-gray-400">API/LLM variable COGS vs MRR</p>
          </div>
          <StatusBadge vocab="marginRisk" value={margin.platform.riskLevel} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label="Gross Margin"
            value={margin.platform.grossMarginPct != null ? `${margin.platform.grossMarginPct}%` : '—'}
            alert={margin.platform.riskLevel === 'action'}
          />
          <StatTile label="Total Revenue (MRR)" value={fmtUsd(margin.platform.totalRevenueUsd)} />
          <StatTile label="Variable API COGS" value={fmtUsd(margin.platform.variableApiCogsUsd)} />
        </div>

        <p className="mt-4 text-xs italic text-gray-500">{margin.platform.note}</p>

        {/* Threshold reference */}
        <div className="mt-3 flex gap-4 text-xs text-gray-400">
          <span>
            Warning below{' '}
            <span className="font-medium text-gray-600">{margin.thresholds.platformWarningPct}%</span>
          </span>
          <span>
            Action below{' '}
            <span className="font-medium text-gray-600">{margin.thresholds.platformActionPct}%</span>
          </span>
        </div>
      </div>

      {/* Top accounts table */}
      <div className="mt-4 rounded-lg border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-700">Top Accounts by API Cost</h3>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-400">
              Warning ≥{margin.thresholds.accountWarningPct}% &nbsp;·&nbsp; Action ≥
              {margin.thresholds.accountActionPct}% of MRR
            </span>
            <button
              type="button"
              onClick={() => setShowRatios((current) => !current)}
              aria-expanded={showRatios}
              aria-controls="margin-accounts-table"
              className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              {showRatios ? 'Hide ratios' : 'Show ratios'}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table id="margin-accounts-table" className="min-w-full divide-y divide-gray-100 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Account</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Tier</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">MRR</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">API Cost</th>
                <th className="px-4 py-3 text-right font-medium text-gray-600">Cost % MRR</th>
                <th className="px-4 py-3 text-center font-medium text-gray-600">Risk</th>
                {showRatios && (
                  <>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">$/Response</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Fallback %</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-600">Flagged %</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {margin.topAccountsByCost.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="px-4 py-6 text-center text-gray-400">
                    No account cost data for this window.
                  </td>
                </tr>
              )}
              {/* No row tint (X19): the Risk badge already says it, and a tinted
                  row fought the hover state and put gray text on a colour. */}
              {margin.topAccountsByCost.map((row: AccountMarginRow) => (
                <tr key={row.accountId} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{row.displayName}</td>
                  <td className="px-4 py-3">
                    <StatusBadge vocab="tier" value={row.subscriptionTier} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtUsd(row.mrrUsd)}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtUsd(row.variableApiCostUsd)}</td>
                  <td
                    className={`px-4 py-3 text-right font-medium ${
                      row.riskLevel === 'action'
                        ? 'text-red-700'
                        : row.riskLevel === 'warning'
                          ? 'text-yellow-700'
                          : 'text-gray-700'
                    }`}
                  >
                    {fmtPct(row.costPctOfMrr)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <StatusBadge vocab="marginRisk" value={row.riskLevel} />
                  </td>
                  {showRatios && (
                    <>
                      <td className="px-4 py-3 text-right text-gray-600">{fmtUsd(row.avgCostPerResponseUsd)}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{fmtPct(row.fallbackRatePct)}</td>
                      <td className="px-4 py-3 text-right text-gray-600">{fmtPct(row.flaggedRatePct)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CostsContent({
  data,
  days,
  onDaysChange,
  page,
  onPageChange,
}: {
  data: CostData;
  days: number;
  onDaysChange: (days: number) => void;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const globalPct = Math.min(Math.round((data.todayTotalUsd / data.globalDailyLimitUsd) * 100), 100);
  const globalBarRed = globalPct >= 80;

  return (
    <>
      {/* Day filter */}
      <div className="flex flex-wrap gap-2">
        {DAY_OPTIONS.map((d) => (
          <button
            type="button"
            key={d}
            onClick={() => onDaysChange(d)}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              days === d
                ? 'bg-gray-900 text-white'
                : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {d}d
          </button>
        ))}
      </div>

      {/* Global daily progress bar */}
      <div className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-baseline justify-between">
          <p className="text-sm font-semibold text-gray-700">Today&apos;s Platform Spend</p>
          <p className={`text-sm font-medium ${globalBarRed ? 'text-red-700' : 'text-gray-600'}`}>
            {fmtUsd(data.todayTotalUsd)} / {fmtUsd(data.globalDailyLimitUsd)}
          </p>
        </div>
        <div className="mt-2 h-3 w-full rounded-full bg-gray-100">
          <div
            className={`h-3 rounded-full transition-all ${globalBarRed ? 'bg-red-500' : 'bg-gray-500'}`}
            style={{ width: `${globalPct}%` }}
          />
        </div>
        <p className="mt-1 text-xs text-gray-400">{globalPct}% of daily limit</p>
      </div>

      {/* By Provider + By Day side by side */}
      <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
        <CostMiniTable
          title="By Provider"
          columnLabel="Provider"
          days={days}
          rows={data.byProvider}
          rowKey={(row) => row.provider}
          primaryLabel={(row) => row.provider}
          primaryClassName="font-medium text-gray-800 capitalize"
          totalUsd={(row) => row.totalUsd}
          callCount={(row) => row.callCount}
        />
        {/* The header carries the zone (X20): `formatAdminDate` is bare by
            design, and a per-row "UTC" would be noise in a date-only column. */}
        <CostMiniTable
          title="By Day"
          columnLabel="Date (UTC)"
          days={days}
          rows={data.byDay}
          rowKey={(row) => row.day}
          primaryLabel={(row) => formatAdminDate(row.day, row.day)}
          primaryClassName="text-gray-700"
          totalUsd={(row) => row.totalUsd}
          callCount={(row) => row.callCount}
        />
      </div>

      {/* By Business */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold text-gray-800">
          By Business ({days}d): {formatAdminCount(data.totalBusinesses)} businesses
        </h2>
        <div className="mt-3">
          <DataTable
            columns={byBusinessColumns(days)}
            rows={data.byBusiness}
            rowKey={(row) => row.businessId}
            serverPagination={{
              page,
              pageSize: PAGE_SIZE,
              totalRows: data.totalBusinesses,
              onPageChange,
            }}
            emptyState={<EmptyState title="No business cost data found" />}
          />
        </div>
      </div>

      {data.margin && <MarginSection margin={data.margin} />}
    </>
  );
}

export function CostsClient({ initialData }: { initialData: CostData }) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, refetch } = useQuery<CostData>({
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
    staleTime: 30_000,
    initialData: days === DEFAULT_DAYS && page === 0 ? initialData : undefined,
  });

  function handleDaysChange(nextDays: number) {
    setDays(nextDays);
    setPage(0);
  }

  // Page chrome (group/title/description) lives on the server page so it
  // renders in the RSC payload, never behind this client's loading state.
  return (
    <>
      {isLoading && !data ? (
        <TableSkeleton />
      ) : isError && !data ? (
        <ErrorState
          title="Couldn't load cost data"
          detail={`GET /api/admin/costs?days=${days} failed`}
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <>
          {isError && (
            <div className="mb-4">
              <ErrorState
                title="Last refresh failed"
                detail={`GET /api/admin/costs?days=${days} failed — showing the last loaded data.`}
                onRetry={() => void refetch()}
              />
            </div>
          )}
          <CostsContent data={data} days={days} onDaysChange={handleDaysChange} page={page} onPageChange={setPage} />
        </>
      ) : null}
    </>
  );
}
