'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required); the
// server page additionally gates with requireAdminPage.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BusinessSummariesResult } from '@/lib/admin/business-summary';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
import { HealthBadge } from '@/components/admin/ui/HealthBadge';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminDate } from '@/components/admin/ui/format';

// Mirrors src/app/api/admin/businesses/route.ts's GET body: the list, total and
// response-metrics window come from BusinessSummariesResult (single owner:
// business-summary.ts, shared with /admin/overview); limit/offset are
// request-echo fields the route adds on top.
type BusinessListData = BusinessSummariesResult & {
  limit: number;
  offset: number;
};

type BusinessRow = BusinessListData['businesses'][number];

import { BUSINESSES_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';

// Coarse "how long ago" for the Last activity column. Absorbed from
// OverviewClient with the metric columns (spec §5.4) — the admin console has
// one spelling of a relative timestamp, and unlike `formatAdminDate` it is
// deliberately zone-free (a relative age needs no zone label).
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

// A function, not a module constant: the two window-labelled headers derive
// their `N` from BusinessSummariesResult.responseMetricsWindowDays (single
// owner: src/lib/admin/business-summary.ts), which is only known at render.
function buildColumns(windowDays: number): DataTableColumn<BusinessRow>[] {
  return [
    {
      key: 'name',
      header: 'Name',
      render: (b) => <span className="font-medium">{b.name}</span>,
      sortValue: (b) => b.name,
    },
    {
      key: 'category',
      header: 'Category',
      render: (b) => b.category ?? <span className="text-gray-400">{'—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (b) => <StatusBadge status={b.subscriptionStatus} />,
    },
    // Header carries the zone: `formatAdminDate` deliberately does not self-label
    // (see src/components/admin/ui/format.ts), and repeating "UTC" per row would
    // be noise in a date-only column.
    { key: 'lastSync', header: 'Last Sync (UTC)', render: (b) => formatAdminDate(b.lastSyncAt, 'Never') },
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

export function BusinessesClient({ initialData }: { initialData: BusinessListData }) {
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, refetch } = useQuery<BusinessListData>({
    queryKey: ['admin-businesses', page],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/businesses?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      );
      if (!res.ok) throw new Error(`Failed to fetch businesses: ${res.status}`);
      return res.json() as Promise<BusinessListData>;
    },
    staleTime: 30_000,
    initialData: page === 0 ? initialData : undefined,
  });

  if (isLoading && !data) return <TableSkeleton />;
  if (isError && !data) {
    return (
      <ErrorState
        title="Couldn't load businesses"
        detail="GET /api/admin/businesses failed"
        onRetry={() => void refetch()}
      />
    );
  }
  if (!data) return null;

  return (
    <>
      {isError && (
        <div className="mb-4">
          <ErrorState
            title="Last refresh failed"
            detail="GET /api/admin/businesses failed — showing the last loaded data."
            onRetry={() => void refetch()}
          />
        </div>
      )}
      <DataTable
        columns={buildColumns(data.responseMetricsWindowDays)}
        rows={data.businesses}
        rowKey={(b) => b.id}
        rowHref={(b) => `/admin/businesses/${b.id}`}
        serverPagination={{
          page,
          pageSize: PAGE_SIZE,
          totalRows: data.total,
          onPageChange: setPage,
        }}
        emptyState={
          <EmptyState title="No businesses found" detail="Add one with + Add Business." />
        }
      />
    </>
  );
}
