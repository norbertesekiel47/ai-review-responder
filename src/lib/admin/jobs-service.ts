// src/lib/admin/jobs-service.ts
//
// Extracted verbatim from src/app/api/admin/jobs/route.ts's GET body (admin
// console Phase 2, Task 3), then widened for the jobs page's triage needs (X15):
// an optional topic filter on the failed page + its count, the distinct failed
// topics that populate the filter, and the business each failed row belongs
// to. Born-injected: `sql` is a parameter, not an import — the composition root
// (the route, and the jobs server page) supplies the singleton (invariant #15).

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
  business_id: string | null;
  business_name: string | null;
}

interface FailedCountRow {
  total: number;
}

interface TopicRow {
  topic: string;
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
    /**
     * Resolved from `payload->>'businessId'` (job_outbox has no business
     * column — every business-scoped payload carries the id, see
     * job-outbox-helpers.ts). Null for platform-wide topics and for a payload
     * whose id no longer resolves to a business.
     */
    businessId: string | null;
    businessName: string | null;
  }[];
  failedTotal: number;
  /** Distinct topics among ALL failed rows (not just this page) — the topic filter's options. */
  failedTopics: string[];
}

export interface AdminJobsFilters {
  limit: number;
  offset: number;
  /** Exact `job_outbox.topic`; absent = every topic. Validated by the route. */
  topic?: string;
}

/**
 * Outbox status summary (incl. `dispatching`), a page of failed jobs, the total
 * failed count and the distinct failed topics — the four queries the jobs panel
 * needs (spec §4 + X15). Queue depth/pool-wait is a separate concern, fetched
 * from the worker by `fetchQueueHealth` (src/lib/admin/queue-health.ts).
 */
export async function getAdminJobsData(
  sql: Sql,
  { limit, offset, topic }: AdminJobsFilters,
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
  //
  // BOUNDED, never a whole-table count (#1365). The WHERE admits only rows some
  // counter reads, one equality arm per status, so the planner BitmapOrs one
  // partial index per arm: `idx_jo_pending`, `idx_jo_recovery` (065),
  // `idx_jo_failed_created` and `idx_jo_completed_at` (124). Do not fold the
  // arms into `status IN (…)`: a ScalarArrayOp implies none of those partial
  // predicates, so the plan falls back to a sequential scan of a table that is
  // mostly `completed` rows (7-day retention) — and the list would have to
  // spell the in-flight tuple byte-for-byte (`ci:outbox-status`).
  const summaryRows = await sql<OutboxSummaryRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'dispatching')::int AS dispatching,
        COUNT(*) FILTER (WHERE status = 'dispatched')::int AS dispatched,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_today
      FROM job_outbox
      WHERE status = 'pending'
         OR status = 'dispatching'
         OR status = 'dispatched'
         OR status = 'failed'
         OR (status = 'completed' AND completed_at >= CURRENT_DATE)
    `;
  // Same predicate on the page and its count so the footer total is the
  // filtered total. Empty fragment when no topic is asked for.
  const topicClause = topic ? sql`AND jo.topic = ${topic}` : sql``;
  // The business join reads the payload's `businessId`. Guarded by a UUID
  // regex before the cast: a payload with no id (platform-wide topics) or a
  // malformed one must yield NULL, never abort the whole page with 22P02.
  const failedRows = await sql<FailedJobRow[]>`
      SELECT jo.id, jo.topic, jo.last_error, jo.attempts, jo.max_attempts, jo.created_at,
             b.id AS business_id, b.name AS business_name
      FROM job_outbox jo
      LEFT JOIN businesses b ON b.id = CASE
        WHEN jo.payload->>'businessId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (jo.payload->>'businessId')::uuid
      END
      WHERE jo.status = 'failed' ${topicClause}
      ORDER BY jo.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  // Not collapsed into a window `COUNT(*) OVER ()`: an empty page (offset past
  // the end) carries no row to hold the total, which would report 0.
  const countRows = await sql<FailedCountRow[]>`
      SELECT COUNT(*)::int AS total FROM job_outbox jo WHERE jo.status = 'failed' ${topicClause}
    `;
  // Unfiltered on purpose: the filter's options must include the topic the
  // operator has NOT selected yet.
  const topicRows = await sql<TopicRow[]>`
      SELECT DISTINCT topic FROM job_outbox WHERE status = 'failed' ORDER BY topic ASC
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
      businessId: row.business_id ?? null,
      businessName: row.business_name ?? null,
    })),
    failedTotal,
    failedTopics: topicRows.map((row) => row.topic),
  };
}

/**
 * The `topic` query param, validated. Outbox topics are lower-snake-case
 * identifiers; anything else is dropped rather than bound. Shared by the route
 * and the server page so `?topic=` means the same thing on both.
 */
export function parseJobsTopicFilter(raw: string | null | undefined): string | undefined {
  const value = (raw ?? '').trim();
  return /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined;
}
