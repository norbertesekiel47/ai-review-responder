'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  QUEUE_HEALTH_JOB_STATES,
  type QueueHealthJobState,
} from '@/lib/shared/queue-health-states';
import type { AdminJobsData } from '@/lib/admin/jobs-service';
import { StatTile } from '@/components/admin/ui/StatTile';
import { DataTable, type DataTableColumn } from '@/components/admin/ui/DataTable';
import { FILTER_SELECT_CLASS } from '@/components/admin/ui/FilterBar';
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

import { JOBS_PAGE_SIZE as PAGE_SIZE } from '../page-sizes';
import { LastUpdated } from '@/components/admin/ui/LastUpdated';

/**
 * Queue-depth presentation (X16). `failed` and `delayed` are the two states an
 * operator acts on, so they are ALWAYS shown and coloured; the other four are
 * bookkeeping and appear only when non-zero, so a healthy queue reads as two
 * quiet zeros instead of six equal-weight numbers.
 */
const ALWAYS_SHOWN_STATES: ReadonlySet<QueueHealthJobState> = new Set(['failed', 'delayed']);

const STATE_STYLES: Record<QueueHealthJobState, string> = {
  waiting: 'border-gray-200 bg-white text-gray-700',
  active: 'border-gray-200 bg-white text-gray-700',
  delayed: 'border-yellow-200 bg-yellow-50 text-yellow-800',
  failed: 'border-red-200 bg-red-50 text-red-800',
  completed: 'border-gray-200 bg-white text-gray-700',
  paused: 'border-gray-200 bg-gray-50 text-gray-600',
};

/** Errors longer than this collapse behind a disclosure; shorter ones render in full. */
const ERROR_INLINE_MAX = 80;

function ErrorCell({ error }: { error: string | null }) {
  if (!error) return <span className="text-gray-400">—</span>;
  if (error.length <= ERROR_INLINE_MAX) {
    return <span className="block max-w-md break-words font-mono text-xs text-gray-800">{error}</span>;
  }
  // A native disclosure, not a hover title: the full error is reachable on
  // touch, by keyboard and by a screen reader (X15).
  return (
    <details className="max-w-md">
      <summary className="cursor-pointer font-mono text-xs text-gray-800">
        {error.slice(0, ERROR_INLINE_MAX)}…{' '}
        <span className="font-sans text-gray-500 underline">show full error</span>
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-gray-50 p-2 font-mono text-xs text-gray-800">
        {error}
      </pre>
    </details>
  );
}

const columns: DataTableColumn<FailedJob>[] = [
  { key: 'topic', header: 'Topic', render: (j) => <span className="font-mono text-xs">{j.topic}</span> },
  {
    key: 'business',
    header: 'Business',
    render: (j) =>
      j.businessId ? (
        <Link href={`/admin/businesses/${j.businessId}`} className="text-gray-900 underline hover:text-gray-600">
          {j.businessName ?? j.businessId}
        </Link>
      ) : (
        <span className="text-gray-400">—</span>
      ),
  },
  { key: 'error', header: 'Error', render: (j) => <ErrorCell error={j.lastError} /> },
  { key: 'attempts', header: 'Attempts', render: (j) => `${j.attempts}/${j.maxAttempts}` },
  { key: 'created', header: 'Created', render: (j) => formatAdminDateTime(j.createdAt) },
];

function QueueDepthCard({ queueName, counts }: { queueName: string; counts: Record<string, number> }) {
  const shown = QUEUE_HEALTH_JOB_STATES.filter(
    (state) => ALWAYS_SHOWN_STATES.has(state) || (counts[state] ?? 0) > 0,
  );
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="mb-3 truncate text-sm font-semibold text-gray-700" title={queueName}>
        {queueName}
      </p>
      <ul className="flex flex-wrap gap-2">
        {shown.map((state) => {
          const count = counts[state] ?? 0;
          const prominent = ALWAYS_SHOWN_STATES.has(state);
          return (
            <li
              key={state}
              className={`inline-flex items-baseline gap-1.5 rounded-md border px-2.5 py-1 ${STATE_STYLES[state]} ${
                prominent && count > 0 ? 'font-semibold' : ''
              }`}
            >
              <span className="text-xs">{state}</span>
              <span className={`tabular-nums ${prominent ? 'text-base font-bold' : 'text-sm font-medium'}`}>{count}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function JobsContent({
  data,
  page,
  onPageChange,
  topic,
  onTopicChange,
}: {
  data: JobsData;
  page: number;
  onPageChange: (page: number) => void;
  topic: string;
  onTopicChange: (topic: string) => void;
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
              <QueueDepthCard key={queueName} queueName={queueName} counts={counts} />
            ))}
          </div>
        )}
      </div>

      {/* Failed jobs table */}
      <div className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-800">
            Failed Outbox Jobs ({formatAdminCount(data.failedTotal)})
          </h2>
          <label className="flex items-center gap-2 text-xs text-gray-600">
            Topic
            <select
              aria-label="Filter failed jobs by topic"
              value={topic}
              onChange={(event) => onTopicChange(event.target.value)}
              className={FILTER_SELECT_CLASS}
            >
              <option value="">All topics</option>
              {data.failedTopics.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
        {/* No retry button, by design (X15): a failed outbox row is terminal and
            re-enqueued from the CLI after the cause is understood. Saying so is
            better than an operator hunting for a control that does not exist. */}
        <p className="mt-1 text-xs text-gray-500">
          Retrying is CLI-only — a failed row is re-enqueued from the command line once the error is
          understood. See the <Link href="/admin/runbook" className="underline hover:text-gray-900">runbook</Link>.
        </p>
        <div className="mt-3">
          <DataTable
            columns={columns}
            rows={data.failedJobs}
            rowKey={(job) => job.id}
            maxHeight="70vh"
            serverPagination={{
              page,
              pageSize: PAGE_SIZE,
              totalRows: data.failedTotal,
              onPageChange,
            }}
            emptyState={
              topic ? (
                <EmptyState title="No failed jobs for this topic" detail="Clear the topic filter to see every failed row." />
              ) : (
                <EmptyState title="No failed jobs" detail="Nothing is stuck right now." />
              )
            }
          />
        </div>
      </div>
    </>
  );
}

export function JobsClient({ initialData }: { initialData: JobsData }) {
  const [page, setPage] = useState(0);
  const [topic, setTopic] = useState('');

  const { data, isLoading, isError, refetch, dataUpdatedAt, isFetching } = useQuery<JobsData>({
    queryKey: ['admin-jobs', page, topic],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
      if (topic) params.set('topic', topic);
      const res = await fetch(`/api/admin/jobs?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch job data: ${res.status}`);
      return res.json() as Promise<JobsData>;
    },
    refetchInterval: 30_000,
    staleTime: 30_000,
    initialData: page === 0 && topic === '' ? initialData : undefined,
  });

  function handleTopicChange(next: string) {
    setTopic(next);
    setPage(0);
  }

  // Page chrome (group/title/description) lives on the server page so it
  // renders in the RSC payload, never behind this client's loading state.
  return (
    <>
      <LastUpdated updatedAt={dataUpdatedAt} refreshing={isFetching} onRefresh={() => void refetch()} />
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
          <JobsContent
            data={data}
            page={page}
            onPageChange={setPage}
            topic={topic}
            onTopicChange={handleTopicChange}
          />
        </>
      ) : null}
    </>
  );
}
