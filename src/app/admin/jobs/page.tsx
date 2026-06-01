'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface JobsData {
  outbox: {
    pending: number;
    dispatching: number;
    dispatched: number;
    failed: number;
    completedToday: number;
  };
  failedJobs: {
    id: string;
    topic: string;
    lastError: string | null;
    attempts: number;
    maxAttempts: number;
    createdAt: string;
  }[];
  failedTotal: number;
  limit: number;
  offset: number;
  queueHealth: Record<string, Record<string, number>> | { unavailable: true };
}

const PAGE_SIZE = 20 as const;

type CardColor = 'yellow' | 'blue' | 'red' | 'green';

const COLOR_CLASSES: Record<
  CardColor,
  { bg: string; border: string; label: string; value: string }
> = {
  yellow: {
    bg: 'bg-yellow-50',
    border: 'border-yellow-200',
    label: 'text-yellow-700',
    value: 'text-yellow-900',
  },
  blue: {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    label: 'text-blue-700',
    value: 'text-blue-900',
  },
  red: {
    bg: 'bg-red-50',
    border: 'border-red-200',
    label: 'text-red-700',
    value: 'text-red-900',
  },
  green: {
    bg: 'bg-green-50',
    border: 'border-green-200',
    label: 'text-green-700',
    value: 'text-green-900',
  },
};

function SummaryCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: CardColor;
}) {
  const cls = COLOR_CLASSES[color];
  return (
    <div className={`rounded-lg border ${cls.border} ${cls.bg} p-5`}>
      <p className={`text-sm font-medium ${cls.label}`}>{label}</p>
      <p className={`mt-1 text-3xl font-bold ${cls.value}`}>{value.toLocaleString()}</p>
    </div>
  );
}

export default function JobsPage() {
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, error } = useQuery<JobsData>({
    queryKey: ['admin-jobs', page],
    queryFn: async () => {
      const offset = page * PAGE_SIZE;
      const res = await fetch(`/api/admin/jobs?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error(`Failed to fetch job data: ${res.status}`);
      return res.json() as Promise<JobsData>;
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
            Failed to load job data.{' '}
            {error instanceof Error ? error.message : ''}
          </p>
        </div>
      </div>
    );
  }

  const totalPages = Math.ceil(data.failedTotal / PAGE_SIZE);
  const queueUnavailable = 'unavailable' in data.queueHealth;
  const queueCounts = queueUnavailable
    ? null
    : (data.queueHealth as Record<string, Record<string, number>>);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900">Job Monitoring</h1>

        {/* Outbox summary */}
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <SummaryCard label="Pending" value={data.outbox.pending} color="yellow" />
          <SummaryCard label="Dispatching" value={data.outbox.dispatching} color="yellow" />
          <SummaryCard label="Dispatched" value={data.outbox.dispatched} color="blue" />
          <SummaryCard label="Failed" value={data.outbox.failed} color="red" />
          <SummaryCard label="Completed Today" value={data.outbox.completedToday} color="green" />
        </div>

        {/* BullMQ queue depth */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-800">BullMQ Queue Depth</h2>

          {queueUnavailable ? (
            <p className="mt-3 text-sm font-medium text-yellow-700">
              Redis unavailable — queue depth cannot be retrieved.
            </p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(queueCounts!).map(([queueName, counts]) => (
                <div
                  key={queueName}
                  className="rounded-lg border border-gray-200 bg-white p-4"
                >
                  <p className="mb-3 truncate text-sm font-semibold text-gray-700" title={queueName}>
                    {queueName}
                  </p>
                  <div className="grid grid-cols-6 gap-2 text-center text-xs">
                    <div>
                      <p className="font-medium text-gray-500">waiting</p>
                      <p className="mt-0.5 text-base font-bold text-gray-800">
                        {counts['waiting'] ?? 0}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-blue-500">active</p>
                      <p className="mt-0.5 text-base font-bold text-blue-700">
                        {counts['active'] ?? 0}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-yellow-500">delayed</p>
                      <p className="mt-0.5 text-base font-bold text-yellow-700">
                        {counts['delayed'] ?? 0}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-red-500">failed</p>
                      <p className="mt-0.5 text-base font-bold text-red-700">
                        {counts['failed'] ?? 0}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-green-500">completed</p>
                      <p className="mt-0.5 text-base font-bold text-green-700">
                        {counts['completed'] ?? 0}
                      </p>
                    </div>
                    <div>
                      <p className="font-medium text-gray-400">paused</p>
                      <p className="mt-0.5 text-base font-bold text-gray-600">
                        {counts['paused'] ?? 0}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Failed jobs table */}
        <div className="mt-8">
          <h2 className="text-lg font-semibold text-gray-800">
            Failed Outbox Jobs ({data.failedTotal.toLocaleString()})
          </h2>
          <div className="mt-3 rounded-lg border border-gray-200 bg-white">
            {data.failedJobs.length === 0 ? (
              <p className="px-4 py-8 text-center text-gray-400">No failed jobs.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-100 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Topic</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Error</th>
                      <th className="px-4 py-3 text-center font-medium text-gray-500">Attempts</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data.failedJobs.map((job) => (
                      <tr key={job.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-800">{job.topic}</td>
                        <td className="max-w-xs px-4 py-3 text-gray-600">
                          <span
                            className="block truncate"
                            title={job.lastError ?? undefined}
                          >
                            {job.lastError ?? '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center text-gray-600">
                          {job.attempts}/{job.maxAttempts}
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          {new Date(job.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-gray-500">
                Page {page + 1} of {totalPages}
              </p>
              <div className="flex gap-2">
                <button type="button"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Prev
                </button>
                <button type="button"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
