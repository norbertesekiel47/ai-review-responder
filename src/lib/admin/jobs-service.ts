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
  // SEQUENCED, NOT `Promise.all` — at most ONE query in flight (#773).
  //
  // The previous comment here reasoned that a fan-out of 3 against
  // `DB_POOL_MAX` = 3 was safe because #505 proved one-connection-per-query
  // non-wedging. Staging measurement on 2026-08-13 DISPROVED that as a
  // sufficient condition: `/api/admin/flagged` wedged with a fan-out of only
  // TWO against the same 3-connection pool, because the pool is per Fluid
  // Compute ISOLATE and is shared across overlapping requests. Fan-out ≤ pool
  // says nothing once two requests land on one isolate. Evidence: branch
  // codex/773-vercel-capacity-decision,
  // docs/runbooks/evidence/2026-08-13-773-vercel-capacity-decision.md.
  //
  // Both callers race this against `fetchQueueHealth`, which remains safe only
  // because that is an HTTP call to the worker and takes no `sql` connection;
  // do not swap it for a DB-backed reader.
  const summaryRows = await sql<OutboxSummaryRow[]>`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending,
        COUNT(CASE WHEN status = 'dispatching' THEN 1 END)::int AS dispatching,
        COUNT(CASE WHEN status = 'dispatched' THEN 1 END)::int AS dispatched,
        COUNT(CASE WHEN status = 'failed' THEN 1 END)::int AS failed,
        COUNT(CASE WHEN status = 'completed' AND completed_at >= CURRENT_DATE THEN 1 END)::int AS completed_today
      FROM job_outbox
    `;
  const failedRows = await sql<FailedJobRow[]>`
      SELECT id, topic, last_error, attempts, max_attempts, created_at
      FROM job_outbox
      WHERE status = 'failed'
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  // Not collapsed into a window `COUNT(*) OVER ()`: an empty page (offset past
  // the end) carries no row to hold the total, which would report 0.
  const countRows = await sql<FailedCountRow[]>`
      SELECT COUNT(*)::int AS total FROM job_outbox WHERE status = 'failed'
    `;

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
