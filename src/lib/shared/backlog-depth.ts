// Single owner of "backlog depth" counting for RepWorth's dispatch queues.
// Backlog depth = the number of status='pending' rows in each dispatch-queue
// table (TOTAL pending, including not-yet-due retry rows — NOT claimable-only,
// so no `available_at <= NOW()` filter). Shared by BOTH the internal
// queue-health endpoint and the HealthAlertPoller check, so the count SQL lives
// in exactly one place. Side-effect-free: no DB singleton, no config at import;
// callers pass the `postgres.Sql` client (invariant #15).
import type postgres from 'postgres';

export const BACKLOG_DEPTH_TABLES = ['job_outbox', 'analytics_events'] as const;

export type BacklogTable = (typeof BACKLOG_DEPTH_TABLES)[number];

export type BacklogDepth = Record<BacklogTable, number>;

// One round-trip: two scalar subqueries collapse to a single result row. Both
// `status = 'pending'` predicates hit existing partial indexes (`idx_jo_pending`,
// `idx_analytics_events_pending`); `::int` avoids bigint-as-string surprises.
export async function queryBacklogDepth(sql: postgres.Sql): Promise<BacklogDepth> {
  const [row] = await sql<BacklogDepth[]>`
    SELECT
      (SELECT COUNT(*)::int FROM job_outbox       WHERE status = 'pending') AS job_outbox,
      (SELECT COUNT(*)::int FROM analytics_events WHERE status = 'pending') AS analytics_events
  `;
  return {
    job_outbox: row?.job_outbox ?? 0,
    analytics_events: row?.analytics_events ?? 0,
  };
}
