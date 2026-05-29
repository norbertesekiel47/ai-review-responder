'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

const PAGE_SIZE = 20;

interface OverviewData {
  systemHealth: {
    pendingOutbox: number;
    failedJobs: number;
    todayCostUsd: number;
    notificationFailures24h: number;
    emailHealth: {
      sent24h: number;
      delivered24h: number;
      bounces7d: number;
      hardBounces7d: number;
      complaints7d: number;
      deliveryRate24h: number;
      redState: boolean;
    };
  };
  totalBusinesses: number;
  limit: number;
  offset: number;
  businesses: {
    id: string;
    name: string;
    subscriptionStatus: string;
    lastSyncAt: string | null;
    pendingApprovalCount: number;
    pendingReconnectCount: number;
    totalResponses: number;
    completedResponses: number;
    responseRate: number;
    avgResponseTimeHours: number | null;
    lastActivity: string | null;
    churnScore: {
      score: number;
      level: 'healthy' | 'watch' | 'at_risk';
      breakdown: Array<{ signal: string; value: string; contribution: number }>;
    };
  }[];
}

function formatRelative(isoString: string | null): string {
  if (!isoString) return '—';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  const classes: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    pending_payment: 'bg-gray-100 text-gray-700',
    past_due: 'bg-yellow-100 text-yellow-800',
    cancelled: 'bg-red-100 text-red-800',
  };
  const label: Record<string, string> = {
    active: 'Active',
    pending_payment: 'Pending',
    past_due: 'Past Due',
    cancelled: 'Cancelled',
  };
  const cls = classes[status] ?? 'bg-gray-100 text-gray-700';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label[status] ?? status}
    </span>
  );
}

interface HealthCardProps {
  label: string;
  value: string;
  warn: boolean;
}

function HealthCard({ label, value, warn }: HealthCardProps) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        warn ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'
      }`}
    >
      <p className={`text-sm font-medium ${warn ? 'text-red-700' : 'text-gray-500'}`}>
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold ${warn ? 'text-red-800' : 'text-gray-900'}`}>
        {value}
      </p>
    </div>
  );
}

function HealthBadge({ level, score }: { level: string; score: number }) {
  const styles: Record<string, string> = {
    healthy: 'bg-green-100 text-green-800',
    watch: 'bg-gray-100 text-gray-700',
    at_risk: 'bg-red-100 text-red-800',
  };
  const labels: Record<string, string> = {
    healthy: 'Healthy',
    watch: 'Watch',
    at_risk: 'At Risk',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${styles[level] ?? styles.healthy}`}>
      {labels[level] ?? level} <span className="opacity-60">{score}</span>
    </span>
  );
}

export default function AdminOverviewPage() {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const { data, isLoading, isError, error } = useQuery<OverviewData>({
    queryKey: ['admin-overview', page],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      const res = await fetch(`/api/admin/overview?${params}`);
      if (!res.ok) throw new Error(`Failed to fetch overview: ${res.status}`);
      return res.json() as Promise<OverviewData>;
    },
    refetchInterval: 30_000,
  });
  const totalPages = data ? Math.ceil(data.totalBusinesses / PAGE_SIZE) : 0;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-8">
          <p className="text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="mx-auto max-w-6xl px-4 py-8">
          <p className="text-red-600">
            Failed to load overview data.{' '}
            {error instanceof Error ? error.message : ''}
          </p>
        </div>
      </div>
    );
  }

  const { systemHealth, businesses } = data;
  // API returns businesses pre-sorted by churn risk score descending

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Admin Overview</h1>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/demos"
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              Demos
            </Link>
            <Link
              href="/admin/businesses"
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              All Businesses
            </Link>
            <Link
              href="/admin/businesses/new"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
            >
              + Add Business
            </Link>
          </div>
        </div>

        {/* System Health */}
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            System Health
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <HealthCard
              label="Pending Outbox"
              value={String(systemHealth.pendingOutbox)}
              warn={systemHealth.pendingOutbox > 10}
            />
            <HealthCard
              label="Failed Jobs"
              value={String(systemHealth.failedJobs)}
              warn={systemHealth.failedJobs > 0}
            />
            <HealthCard
              label="Today's API Cost"
              value={`$${systemHealth.todayCostUsd.toFixed(2)}`}
              warn={false}
            />
            <HealthCard
              label="Notif Failures (24h)"
              value={String(systemHealth.notificationFailures24h)}
              warn={systemHealth.notificationFailures24h > 0}
            />
            <div
              className={`rounded-lg border p-4 ${
                systemHealth.emailHealth.redState
                  ? 'border-red-300 bg-red-50'
                  : 'border-green-200 bg-green-50'
              }`}
            >
              <p
                className={`text-sm font-medium ${
                  systemHealth.emailHealth.redState ? 'text-red-700' : 'text-green-700'
                }`}
              >
                Email Health
              </p>
              <p
                className={`mt-1 text-2xl font-bold ${
                  systemHealth.emailHealth.redState ? 'text-red-800' : 'text-green-800'
                }`}
              >
                {systemHealth.emailHealth.deliveryRate24h}%
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {systemHealth.emailHealth.sent24h} sent (24h) ·{' '}
                {systemHealth.emailHealth.hardBounces7d} hard bounces ·{' '}
                {systemHealth.emailHealth.complaints7d} complaints (7d)
              </p>
            </div>
          </div>
        </section>

        {/* Business Table */}
        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Businesses ({businesses.length})
          </h2>
          <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Pending</th>
                  <th
                    className="px-4 py-3 text-left font-medium text-gray-500"
                    title="Approved responses queued waiting for the owner to (re)connect Zernio"
                  >
                    Reconnect
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Response Rate</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Avg Time</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Last Activity</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {businesses.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-gray-400">
                      No businesses found.
                    </td>
                  </tr>
                )}
                {businesses.map((biz) => (
                  <tr
                    key={biz.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => router.push(`/admin/businesses/${biz.id}`)}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/businesses/${biz.id}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {biz.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={biz.subscriptionStatus} />
                    </td>
                    <td className="px-4 py-3">
                      {biz.pendingApprovalCount > 0 ? (
                        <span className="inline-block rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
                          {biz.pendingApprovalCount}
                        </span>
                      ) : (
                        <span className="text-gray-400">0</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {biz.pendingReconnectCount >= 3 ? (
                        <span className="inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                          {biz.pendingReconnectCount}
                        </span>
                      ) : biz.pendingReconnectCount > 0 ? (
                        <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                          {biz.pendingReconnectCount}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {biz.responseRate}%
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {biz.avgResponseTimeHours !== null
                        ? `${biz.avgResponseTimeHours}h`
                        : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatRelative(biz.lastActivity)}
                    </td>
                    <td className="px-4 py-3">
                      <HealthBadge level={biz.churnScore.level} score={biz.churnScore.score} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200">
              <p className="text-sm text-gray-500">
                Showing {(data?.offset ?? 0) + 1}–{Math.min((data?.offset ?? 0) + PAGE_SIZE, data?.totalBusinesses ?? 0)} of {data?.totalBusinesses ?? 0}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40"
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page >= totalPages - 1}
                  className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
