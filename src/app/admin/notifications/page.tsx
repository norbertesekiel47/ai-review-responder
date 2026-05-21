'use client';

// Auth: Supabase session checked by src/middleware.ts (admin role required)

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface NotifData {
  notifications: {
    id: string;
    businessName: string;
    channel: string;
    recipient: string;
    template: string;
    sentAt: string | null;
    deliveredAt: string | null;
    failedAt: string | null;
    failureReason: string | null;
    createdAt: string;
  }[];
  total: number;
  limit: number;
  offset: number;
  businesses: { id: string; name: string }[];
}

const PAGE_SIZE = 20 as const;

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function NotificationsPage() {
  const [page, setPage] = useState(0);
  const [businessId, setBusinessId] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');

  const { data, isLoading, isError, error } = useQuery<NotifData>({
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
  });

  function handleFilterChange(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLSelectElement>) => {
      setter(e.target.value);
      setPage(0);
    };
  }

  function handleReset() {
    setBusinessId('');
    setChannel('');
    setStatus('');
    setPage(0);
  }

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
            Failed to load notification data.{' '}
            {error instanceof Error ? error.message : ''}
          </p>
        </div>
      </div>
    );
  }

  const rangeStart = data.total === 0 ? 0 : data.offset + 1;
  const rangeEnd = Math.min(data.offset + PAGE_SIZE, data.total);
  const totalPages = Math.ceil(data.total / PAGE_SIZE);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900">Notification Delivery Log</h1>

        {/* Filters bar */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {/* Business filter */}
          <select
            value={businessId}
            onChange={handleFilterChange(setBusinessId)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Businesses</option>
            {data.businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>

          {/* Channel filter */}
          <select
            value={channel}
            onChange={handleFilterChange(setChannel)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Channels</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>

          {/* Status filter */}
          <select
            value={status}
            onChange={handleFilterChange(setStatus)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Statuses</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
          </select>

          <button
            onClick={handleReset}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            Reset
          </button>
        </div>

        {/* Table */}
        <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-100 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Channel</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Recipient</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Template</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Sent</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.notifications.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-400">
                    No notification deliveries found.
                  </td>
                </tr>
              )}
              {data.notifications.map((notif) => {
                let statusBadge: React.ReactNode;
                if (notif.deliveredAt) {
                  statusBadge = (
                    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
                      Delivered
                    </span>
                  );
                } else if (notif.failedAt) {
                  statusBadge = (
                    <span
                      className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 cursor-help"
                      title={notif.failureReason ?? undefined}
                    >
                      Failed
                    </span>
                  );
                } else {
                  statusBadge = (
                    <span className="inline-block rounded px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-700">
                      Pending
                    </span>
                  );
                }

                return (
                  <tr key={notif.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {notif.businessName}
                    </td>
                    <td className="px-4 py-3 capitalize text-gray-700">
                      {notif.channel}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 font-mono">
                      {notif.recipient}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{notif.template}</td>
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                      {formatDate(notif.sentAt)}
                    </td>
                    <td className="px-4 py-3">{statusBadge}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
          <span>
            {data.total === 0
              ? 'No results'
              : `Showing ${rangeStart}–${rangeEnd} of ${data.total}`}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => p - 1)}
              disabled={page === 0}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Prev
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages - 1}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 font-medium hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
