'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

const PAGE_SIZE = 20;

interface BusinessListData {
  businesses: {
    id: string;
    name: string;
    category: string | null;
    subscriptionStatus: string;
    lastSyncAt: string | null;
    pendingCount: number;
  }[];
  total: number;
  limit: number;
  offset: number;
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  active: { bg: 'bg-green-100', text: 'text-green-800' },
  pending_payment: { bg: 'bg-gray-100', text: 'text-gray-700' },
  past_due: { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  cancelled: { bg: 'bg-red-100', text: 'text-red-700' },
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? { bg: 'bg-gray-100', text: 'text-gray-700' };
  const label = status.replace(/_/g, ' ');
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium capitalize ${style.bg} ${style.text}`}>
      {label}
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function BusinessListPage() {
  const [page, setPage] = useState(0);
  const router = useRouter();

  const { data, isLoading, isError } = useQuery<BusinessListData>({
    queryKey: ['admin-businesses', page],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/businesses?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      );
      if (!res.ok) throw new Error('Failed to fetch businesses');
      return res.json() as Promise<BusinessListData>;
    },
  });

  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const startItem = page * PAGE_SIZE + 1;
  const endItem = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Businesses</h1>
          <Link
            href="/admin/businesses/new"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            Add Business
          </Link>
        </div>

        {/* Loading state */}
        {isLoading && (
          <div className="py-12 text-center text-sm text-gray-500">Loading…</div>
        )}

        {/* Error state */}
        {isError && (
          <div className="py-12 text-center text-sm text-red-500">
            Failed to load businesses.
          </div>
        )}

        {/* Table */}
        {data && (
          <>
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Category
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Last Sync
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Pending
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {data.businesses.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="py-12 text-center text-sm text-gray-400"
                      >
                        No businesses found.
                      </td>
                    </tr>
                  ) : (
                    data.businesses.map((biz) => (
                      <tr
                        key={biz.id}
                        className="cursor-pointer transition-colors hover:bg-gray-50"
                        onClick={() => router.push(`/admin/businesses/${biz.id}`)}
                      >
                        <td className="px-4 py-3 text-sm font-medium text-blue-600">
                          {biz.name}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {biz.category ?? <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={biz.subscriptionStatus} />
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {formatDate(biz.lastSyncAt)}
                        </td>
                        <td className="px-4 py-3">
                          {biz.pendingCount > 0 ? (
                            <span className="inline-block rounded bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
                              {biz.pendingCount}
                            </span>
                          ) : (
                            <span className="text-sm text-gray-400">0</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
                <span>
                  Showing {startItem}–{endItem} of {total}
                </span>
                <div className="flex gap-2">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                    className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                    className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
