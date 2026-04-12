'use client';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import type { OverviewData } from '@/app/api/admin/overview/route';

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

export default function AdminOverviewPage() {
  const router = useRouter();
  const { data, isLoading, isError, error } = useQuery<OverviewData>({
    queryKey: ['admin-overview'],
    queryFn: async () => {
      const res = await fetch('/api/admin/overview');
      if (!res.ok) throw new Error(`Failed to fetch overview: ${res.status}`);
      return res.json() as Promise<OverviewData>;
    },
    refetchInterval: 30_000,
  });

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

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900">Admin Overview</h1>

        {/* System Health */}
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            System Health
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
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
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Response Rate</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Avg Time</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Last Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {businesses.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
