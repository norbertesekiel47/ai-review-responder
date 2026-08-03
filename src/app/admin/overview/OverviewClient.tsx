'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { OverviewData } from '@/lib/admin/overview-service';
import { navCountsQueryOptions } from '@/components/admin/nav-counts-query';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { StatTile } from '@/components/admin/ui/StatTile';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';

const PAGE_SIZE = 20;

type BusinessRow = OverviewData['businesses'][number];

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

const HEALTH_BADGE_STYLES: Record<string, string> = {
  healthy: 'bg-green-100 text-green-800',
  watch: 'bg-gray-100 text-gray-700',
  at_risk: 'bg-red-100 text-red-800',
};
const HEALTH_BADGE_LABELS: Record<string, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At Risk',
};

function HealthBadge({ level, score }: { level: string; score: number }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${HEALTH_BADGE_STYLES[level] ?? HEALTH_BADGE_STYLES.healthy}`}>
      {HEALTH_BADGE_LABELS[level] ?? level} <span className="opacity-60">{score}</span>
    </span>
  );
}

function buildColumns(windowDays: number): DataTableColumn<BusinessRow>[] {
  return [
    { key: 'name', header: 'Name', render: (b) => <span className="font-medium">{b.name}</span>, sortValue: (b) => b.name },
    { key: 'status', header: 'Status', render: (b) => <StatusBadge status={b.subscriptionStatus} /> },
    {
      key: 'pending',
      header: 'Pending',
      render: (b) =>
        b.pendingApprovalCount > 0 ? (
          <span className="inline-block rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
            {b.pendingApprovalCount}
          </span>
        ) : (
          <span className="text-gray-400">0</span>
        ),
      sortValue: (b) => b.pendingApprovalCount,
    },
    {
      key: 'reconnect',
      header: 'Reconnect',
      render: (b) =>
        b.pendingReconnectCount >= 3 ? (
          <span className="inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
            {b.pendingReconnectCount}
          </span>
        ) : b.pendingReconnectCount > 0 ? (
          <span className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {b.pendingReconnectCount}
          </span>
        ) : (
          <span className="text-gray-400">{'—'}</span>
        ),
    },
    {
      key: 'responseRate',
      header: `Response rate (${windowDays}d)`,
      render: (b) => <span className="text-gray-700">{b.responseRate}%</span>,
      sortValue: (b) => b.responseRate,
    },
    {
      key: 'avgTime',
      header: `Avg time (${windowDays}d)`,
      render: (b) => (
        <span className="text-gray-700">
          {b.avgResponseTimeHours !== null ? `${b.avgResponseTimeHours}h` : '—'}
        </span>
      ),
    },
    {
      key: 'lastActivity',
      header: 'Last activity',
      render: (b) => <span className="text-gray-500">{formatRelative(b.lastActivity)}</span>,
    },
    {
      key: 'health',
      header: 'Health',
      render: (b) => <HealthBadge level={b.churnScore.level} score={b.churnScore.score} />,
    },
  ];
}

function OverviewContent({
  data,
  flaggedOpen,
  page,
  onPageChange,
}: {
  data: OverviewData;
  flaggedOpen: number;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const { systemHealth, responseMetricsWindowDays } = data;

  const attention = [
    systemHealth.failedJobs > 0 && {
      href: '/admin/jobs',
      label: `${systemHealth.failedJobs} failed job(s)`,
    },
    flaggedOpen > 0 && {
      href: '/admin/flagged',
      label: `${flaggedOpen} flagged response(s) awaiting review`,
    },
    systemHealth.pendingOutbox > 10 && {
      href: '/admin/jobs',
      label: `${systemHealth.pendingOutbox} outbox rows pending`,
    },
    (systemHealth.notificationFailures24h > 0 || systemHealth.emailHealth.redState) && {
      href: '/admin/notifications',
      label: 'notification delivery needs a look',
    },
  ].filter(Boolean) as { href: string; label: string }[];

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile
          label="Pending Outbox"
          value={systemHealth.pendingOutbox.toLocaleString()}
          alert={systemHealth.pendingOutbox > 10}
        />
        <StatTile
          label="Failed Jobs"
          value={systemHealth.failedJobs.toLocaleString()}
          alert={systemHealth.failedJobs > 0}
        />
        <StatTile label="Today's API Cost" value={`$${systemHealth.todayCostUsd.toFixed(2)}`} />
        <StatTile
          label="Notif Failures (24h)"
          value={systemHealth.notificationFailures24h.toLocaleString()}
          alert={systemHealth.notificationFailures24h > 0}
        />
        <StatTile
          label="Email Health"
          value={`${systemHealth.emailHealth.deliveryRate24h}%`}
          alert={systemHealth.emailHealth.redState}
          sub={
            <>
              {systemHealth.emailHealth.sent24h} sent (24h) ·{' '}
              {systemHealth.emailHealth.hardBounces7d} hard bounces ·{' '}
              {systemHealth.emailHealth.complaints7d} complaints (7d)
            </>
          }
        />
      </div>

      {attention.length > 0 && (
        <div className="mt-4 rounded-md border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">Needs attention</h2>
          <ul className="mt-2 space-y-1">
            {attention.map((item) => (
              <li key={item.href + item.label}>
                <Link href={item.href} className="text-sm text-blue-600 hover:underline">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800">
          Businesses ({data.totalBusinesses.toLocaleString()})
        </h2>
        <div className="mt-3">
          <DataTable
            columns={buildColumns(responseMetricsWindowDays)}
            rows={data.businesses}
            rowKey={(b) => b.id}
            rowHref={(b) => `/admin/businesses/${b.id}`}
            serverPagination={{
              page,
              pageSize: PAGE_SIZE,
              totalRows: data.totalBusinesses,
              onPageChange,
            }}
            emptyState={<EmptyState title="No businesses found" />}
          />
        </div>
      </div>
    </>
  );
}

export function OverviewClient({
  initialData,
  flaggedOpen,
}: {
  initialData: OverviewData;
  flaggedOpen: number;
}) {
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, refetch } = useQuery<OverviewData>({
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
    initialData: page === 0 ? initialData : undefined,
  });

  // Same cache entry the sidebar's Flagged badge reads (navCountsQueryOptions
  // is the single owner of the queryKey/fetcher/poll cadence) — the
  // needs-attention strip's flagged-response line must never disagree with
  // the sidebar badge on screen at once. Seeded from the server-provided
  // flaggedOpen prop plus this page's already-fetched failedJobs so the tile
  // never flashes 0 before the shared query resolves.
  const { data: navCounts } = useQuery({
    ...navCountsQueryOptions,
    initialData: { flaggedOpen, failedJobs: initialData.systemHealth.failedJobs },
  });

  return (
    <AdminPage
      group="Operate"
      title="Overview"
      description="System health and every business at a glance"
      actions={
        <>
          <Link
            href="/admin/demos"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Demos
          </Link>
          <Link
            href="/admin/businesses"
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            All Businesses
          </Link>
          <Link
            href="/admin/businesses/new"
            className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            + Add Business
          </Link>
        </>
      }
    >
      {isLoading && !data ? (
        <TableSkeleton />
      ) : isError && !data ? (
        <ErrorState
          title="Couldn't load overview"
          detail="GET /api/admin/overview failed"
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <>
          {isError && (
            <div className="mb-4">
              <ErrorState
                title="Last refresh failed"
                detail="GET /api/admin/overview failed — showing the last loaded data."
                onRetry={() => void refetch()}
              />
            </div>
          )}
          <OverviewContent
            data={data}
            flaggedOpen={navCounts.flaggedOpen}
            page={page}
            onPageChange={setPage}
          />
        </>
      ) : null}
    </AdminPage>
  );
}
