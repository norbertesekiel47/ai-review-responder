// src/lib/admin/jobs-service.ts
//
// Extracted verbatim from src/app/api/admin/jobs/route.ts's GET body (admin
// console Phase 2, Task 3). Same three queries, same Promise.all structure,
// same row→DTO mapping. Born-injected: `sql` is a parameter, not an import —
// the composition root (the route, and later the jobs server page) supplies
// the singleton (invariant #15).

import type { Sql } from 'postgres';

interface OutboxSummaryRow {
  pending: number;
  // `dispatching` is the intermediate two-phase-claim state OutboxPoller
  // transitions rows through (pending → dispatching → dispatched). Stale
  // dispatching rows (>2 min) are recovered by the poller's watchdog, but
  // before 20e they were invisible in this summary, which hid stuck claims.
  dispatching: number;
  dispatched: number;
  failed: number;
  completed_today: number;
}

interface FailedJobRow {
  id: string;
  topic: string;
  last_error: string | null;
  attempts: number;
  max_attempts: number;
  created_at: Date;
}

interface FailedCountRow {
  total: number;
}

export interface AdminJobsData {
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
}

/**
 * Outbox status summary (incl. `dispatching`), a page of failed jobs, and the
 * total failed count — the three queries the jobs panel needs (spec §4).
 * Queue depth/pool-wait is a separate concern, fetched from the worker by
 * `fetchQueueHealth` (src/lib/admin/queue-health.ts).
 */
export async function getAdminJobsData(
  sql: Sql,
  { limit, offset }: { limit: number; offset: number },
): Promise<AdminJobsData> {
  const [summaryRows, failedRows, countRows] = await Promise.all([
    sql<OutboxSummaryRow[]>`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending,
        COUNT(CASE WHEN status = 'dispatching' THEN 1 END)::int AS dispatching,
        COUNT(CASE WHEN status = 'dispatched' THEN 1 END)::int AS dispatched,
        COUNT(CASE WHEN status = 'failed' THEN 1 END)::int AS failed,
        COUNT(CASE WHEN status = 'completed' AND completed_at >= CURRENT_DATE THEN 1 END)::int AS completed_today
      FROM job_outbox
    `,
    sql<FailedJobRow[]>`
      SELECT id, topic, last_error, attempts, max_attempts, created_at
      FROM job_outbox
      WHERE status = 'failed'
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql<FailedCountRow[]>`
      SELECT COUNT(*)::int AS total FROM job_outbox WHERE status = 'failed'
    `,
  ]);

  const summary = summaryRows[0] ?? { pending: 0, dispatching: 0, dispatched: 0, failed: 0, completed_today: 0 };
  const failedTotal = countRows[0]?.total ?? 0;

  return {
    outbox: {
      pending: summary.pending,
      dispatching: summary.dispatching,
      dispatched: summary.dispatched,
      failed: summary.failed,
      completedToday: summary.completed_today,
    },
    failedJobs: failedRows.map((row) => ({
      id: row.id,
      topic: row.topic,
      lastError: row.last_error,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at.toISOString(),
    })),
    failedTotal,
  };
}
