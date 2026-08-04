'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  QUEUE_HEALTH_JOB_STATES,
  type QueueHealthJobState,
} from '@/lib/shared/queue-health-states';
import type { AdminJobsData } from '@/lib/admin/jobs-service';
import { StatTile } from '@/components/admin/ui/StatTile';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/admin/ui/states';
import { formatAdminCount, formatAdminDateTime } from '@/components/admin/ui/format';

// Local HTTP-boundary mirror; canonical owner is src/lib/shared/pool-wait.ts (PoolWait).
type PoolWaitPayload = { waitMs: number; timedOut: boolean; saturating: boolean; max: number };

// Mirrors src/app/api/admin/jobs/route.ts's JobsData exactly: the outbox
// summary + failed-jobs page come from AdminJobsData (single owner:
// jobs-service.ts); queueHealth/pool/limit/offset are request-echo fields the
// route adds on top, not part of the service's DTO.
type JobsData = AdminJobsData & {
  limit: number;
  offset: number;
  queueHealth: Record<string, Record<string, number>> | { unavailable: true };
  pool: PoolWaitPayload | null;
};

type FailedJob = JobsData['failedJobs'][number];

export const PAGE_SIZE = 20 as const;

const STATE_STYLES: Record<QueueHealthJobState, { label: string; value: string }> = {
  waiting: { label: 'text-gray-500', value: 'text-gray-800' },
  active: { label: 'text-gray-500', value: 'text-gray-800' },
  delayed: { label: 'text-yellow-500', value: 'text-yellow-700' },
  failed: { label: 'text-red-500', value: 'text-red-700' },
  completed: { label: 'text-gray-500', value: 'text-gray-800' },
  paused: { label: 'text-gray-400', value: 'text-gray-600' },
};

const columns: DataTableColumn<FailedJob>[] = [
  { key: 'topic', header: 'Topic', render: (j) => <span className="font-mono text-xs">{j.topic}</span> },
  {
    key: 'error',
    header: 'Error',
    render: (j) => (
      <span className="block max-w-md truncate" title={j.lastError ?? ''}>
        {j.lastError ?? '—'}
      </span>
    ),
  },
  { key: 'attempts', header: 'Attempts', render: (j) => `${j.attempts}/${j.maxAttempts}` },
  { key: 'created', header: 'Created', render: (j) => formatAdminDateTime(j.createdAt) },
];

function JobsContent({
  data,
  page,
  onPageChange,
}: {
  data: JobsData;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const queueUnavailable = 'unavailable' in data.queueHealth;
  const queueCounts = queueUnavailable
    ? null
    : (data.queueHealth as Record<string, Record<string, number>>);
  const pool = data.pool;

  return (
    <>
      {/* Outbox summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile
          label="Pending"
          value={formatAdminCount(data.outbox.pending)}
          alert={data.outbox.pending > 10}
        />
        <StatTile label="Dispatching" value={formatAdminCount(data.outbox.dispatching)} />
        <StatTile label="Dispatched" value={formatAdminCount(data.outbox.dispatched)} />
        <StatTile
          label="Failed"
          value={formatAdminCount(data.outbox.failed)}
          alert={data.outbox.failed > 0}
        />
        <StatTile label="Completed Today" value={formatAdminCount(data.outbox.completedToday)} />
      </div>

      {/* BullMQ queue depth */}
      <div className="mt-8">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold text-gray-800">BullMQ Queue Depth</h2>
          {/* Shared Postgres pool-wait sample (read-only). Warning style when
              saturating; `≥` prefix when the sample is a censored lower bound. */}
          {pool === null ? (
            <span className="rounded-full border border-yellow-200 bg-yellow-50 px-2.5 py-0.5 text-xs font-medium text-yellow-700">
              Pool wait: unavailable
            </span>
          ) : (
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                pool.saturating
                  ? 'border-red-200 bg-red-50 text-red-700'
                  : 'border-gray-200 bg-white text-gray-600'
              }`}
              title={`Shared pool wait (max ${pool.max} connections)`}
            >
              Pool wait: {pool.timedOut ? '≥' : ''}
              {formatAdminCount(pool.waitMs)} ms
            </span>
          )}
        </div>

        {queueUnavailable ? (
          <p className="mt-3 text-sm font-medium text-yellow-700">
            Redis unavailable; queue depth cannot be retrieved.
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
                  {QUEUE_HEALTH_JOB_STATES.map((state) => (
                    <div key={state}>
                      <p className={`font-medium ${STATE_STYLES[state].label}`}>{state}</p>
                      <p className={`mt-0.5 text-base font-bold ${STATE_STYLES[state].value}`}>
                        {counts[state] ?? 0}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Failed jobs table */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800">
          Failed Outbox Jobs ({formatAdminCount(data.failedTotal)})
        </h2>
        <div className="mt-3">
          <DataTable
            columns={columns}
            rows={data.failedJobs}
            rowKey={(job) => job.id}
            serverPagination={{
              page,
              pageSize: PAGE_SIZE,
              totalRows: data.failedTotal,
              onPageChange,
            }}
            emptyState={<EmptyState title="No failed jobs" detail="Nothing is stuck right now." />}
          />
        </div>
      </div>
    </>
  );
}

export function JobsClient({ initialData }: { initialData: JobsData }) {
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, refetch } = useQuery<JobsData>({
    queryKey: ['admin-jobs', page],
    queryFn: async () => {
      const offset = page * PAGE_SIZE;
      const res = await fetch(`/api/admin/jobs?limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error(`Failed to fetch job data: ${res.status}`);
      return res.json() as Promise<JobsData>;
    },
    refetchInterval: 30_000,
    staleTime: 30_000,
    initialData: page === 0 ? initialData : undefined,
  });

  // Page chrome (group/title/description) lives on the server page so it
  // renders in the RSC payload, never behind this client's loading state.
  return (
    <>
      {isLoading && !data ? (
        <TableSkeleton />
      ) : isError && !data ? (
        <ErrorState
          title="Couldn't load jobs"
          detail="GET /api/admin/jobs failed"
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <>
          {isError && (
            <div className="mb-4">
              <ErrorState
                title="Last refresh failed"
                detail="GET /api/admin/jobs failed — showing the last loaded data."
                onRetry={() => void refetch()}
              />
            </div>
          )}
          <JobsContent data={data} page={page} onPageChange={setPage} />
        </>
      ) : null}
    </>
  );
}
