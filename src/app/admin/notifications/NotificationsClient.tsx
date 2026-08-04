'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AdminNotificationsData } from '@/lib/admin/notifications-service';
import { StatusBadge } from '@/components/admin/ui/StatusBadge';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminDateTime } from '@/components/admin/ui/format';

// Mirrors src/app/api/admin/notifications/route.ts's NotifData exactly: the
// delivery log + businesses dropdown come from AdminNotificationsData (single
// owner: notifications-service.ts); limit/offset are request-echo fields the
// route adds on top.
type NotifData = AdminNotificationsData & { limit: number; offset: number };

type Delivery = NotifData['notifications'][number];

export const PAGE_SIZE = 20 as const;


function deliveryStatus(d: Delivery): 'delivered' | 'failed' | 'pending' {
  if (d.deliveredAt) return 'delivered';
  if (d.failedAt) return 'failed';
  return 'pending';
}

const columns: DataTableColumn<Delivery>[] = [
  { key: 'business', header: 'Business', render: (d) => <span className="font-medium text-gray-800">{d.businessName}</span> },
  { key: 'channel', header: 'Channel', render: (d) => <span className="capitalize text-gray-700">{d.channel}</span> },
  { key: 'recipient', header: 'Recipient', render: (d) => <span className="font-mono text-xs text-gray-500">{d.recipient}</span> },
  { key: 'template', header: 'Template', render: (d) => <span className="text-gray-700">{d.template}</span> },
  { key: 'sent', header: 'Sent', render: (d) => <span className="whitespace-nowrap text-gray-600">{formatAdminDateTime(d.sentAt)}</span> },
  {
    key: 'status',
    header: 'Status',
    render: (d) => (
      <span title={d.failureReason ?? undefined}>
        <StatusBadge status={deliveryStatus(d)} />
      </span>
    ),
  },
];

function NotificationsContent({
  data,
  page,
  onPageChange,
  businessId,
  onBusinessIdChange,
  channel,
  onChannelChange,
  status,
  onStatusChange,
  onReset,
}: {
  data: NotifData;
  page: number;
  onPageChange: (page: number) => void;
  businessId: string;
  onBusinessIdChange: (v: string) => void;
  channel: string;
  onChannelChange: (v: string) => void;
  status: string;
  onStatusChange: (v: string) => void;
  onReset: () => void;
}) {
  return (
    <>
      {/* Filters toolbar — three selects don't fit FilterBar's search box, so
          they stay a plain toolbar row (spec §5 exception). */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={businessId}
          onChange={(e) => onBusinessIdChange(e.target.value)}
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          <option value="">All Businesses</option>
          {data.businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        <select
          value={channel}
          onChange={(e) => onChannelChange(e.target.value)}
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          <option value="">All Channels</option>
          <option value="email">Email</option>
        </select>

        <select
          value={status}
          onChange={(e) => onStatusChange(e.target.value)}
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          <option value="">All Statuses</option>
          <option value="delivered">Delivered</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
        </select>

        <button
          type="button"
          onClick={onReset}
          className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-900"
        >
          Reset
        </button>
      </div>

      <div className="mt-4">
        <DataTable
          columns={columns}
          rows={data.notifications}
          rowKey={(d) => d.id}
          serverPagination={{
            page,
            pageSize: PAGE_SIZE,
            totalRows: data.total,
            onPageChange,
          }}
          emptyState={<EmptyState title="No notification deliveries found" />}
        />
      </div>
    </>
  );
}

export function NotificationsClient({ initialData }: { initialData: NotifData }) {
  const [page, setPage] = useState(0);
  const [businessId, setBusinessId] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');

  const noFilters = businessId === '' && channel === '' && status === '';

  const { data, isLoading, isError, refetch } = useQuery<NotifData>({
    queryKey: ['admin-notifications', page, businessId, channel, status],
    queryFn: async () => {
      const sp = new URLSearchParams();
      sp.set('limit', String(PAGE_SIZE));
      sp.set('offset', String(page * PAGE_SIZE));
      if (businessId) sp.set('business_id', businessId);
      if (channel) sp.set('channel', channel);
      if (status) sp.set('status', status);

      const res = await fetch(`/api/admin/notifications?${sp.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch notifications: ${res.status}`);
      return res.json() as Promise<NotifData>;
    },
    staleTime: 30_000,
    initialData: page === 0 && noFilters ? initialData : undefined,
  });

  function handleFilterChange(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setPage(0);
    };
  }

  function handleReset() {
    setBusinessId('');
    setChannel('');
    setStatus('');
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
          title="Couldn't load notifications"
          detail="GET /api/admin/notifications failed"
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <>
          {isError && (
            <div className="mb-4">
              <ErrorState
                title="Last refresh failed"
                detail="GET /api/admin/notifications failed — showing the last loaded data."
                onRetry={() => void refetch()}
              />
            </div>
          )}
          <NotificationsContent
            data={data}
            page={page}
            onPageChange={setPage}
            businessId={businessId}
            onBusinessIdChange={handleFilterChange(setBusinessId)}
            channel={channel}
            onChannelChange={handleFilterChange(setChannel)}
            status={status}
            onStatusChange={handleFilterChange(setStatus)}
            onReset={handleReset}
          />
        </>
      ) : null}
    </>
  );
}
