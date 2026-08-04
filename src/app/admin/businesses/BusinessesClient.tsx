'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required); the
// server page additionally gates with requireAdminPage.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminBusinessesList } from '@/lib/admin/businesses-list-service';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';

// Mirrors src/app/api/admin/businesses/route.ts's GET body: the list + total
// come from AdminBusinessesList (single owner: businesses-list-service.ts);
// limit/offset are request-echo fields the route adds on top.
type BusinessListData = AdminBusinessesList & {
  limit: number;
  offset: number;
};

type BusinessRow = BusinessListData['businesses'][number];

export const PAGE_SIZE = 20 as const;

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const columns: DataTableColumn<BusinessRow>[] = [
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
  { key: 'lastSync', header: 'Last Sync', render: (b) => formatDate(b.lastSyncAt) },
  {
    key: 'pending',
    header: 'Pending',
    render: (b) =>
      b.pendingCount > 0 ? (
        <span className="inline-block rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
          {b.pendingCount}
        </span>
      ) : (
        <span className="text-gray-400">0</span>
      ),
  },
];

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
        columns={columns}
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
