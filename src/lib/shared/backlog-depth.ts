// Single owner of "backlog depth" counting for RepWorth's dispatch queues.
// Backlog depth = the number of status='pending' rows in each dispatch-queue
// table (TOTAL pending, including not-yet-due retry rows — NOT claimable-only,
// so no `available_at <= NOW()` filter). Shared by BOTH the internal
// queue-health endpoint and the HealthAlertPoller check, so the count SQL lives
// in exactly one place. Side-effect-free: no DB singleton, no config at import;
// callers pass the `postgres.Sql` client (invariant #15).
//
// The count runs inside a transaction with a per-query `SET LOCAL
// statement_timeout` so Postgres ITSELF cancels a slow count at ~4s and releases
// the pooled connection — a caller-side `withTimeout` only stops WAITING and
// would leave the count running server-side (up to the 30s statement_timeout),
// holding one of the ~10 shared pool connections. Bounding the DB op prevents
// concurrent endpoint hits from starving outbox/webhooks/jobs under DB
// degradation (adversarial-review F-high).
import type postgres from 'postgres';

export const BACKLOG_DEPTH_TABLES = ['job_outbox', 'analytics_events'] as const;

export type BacklogTable = (typeof BACKLOG_DEPTH_TABLES)[number];

export type BacklogDepth = Record<BacklogTable, number>;

const BACKLOG_QUERY_STATEMENT_TIMEOUT_MS = 4000; // Postgres cancels a slow count here, freeing the pooled connection (adversarial-review F-high)

// One round-trip inside a transaction: two scalar subqueries collapse to a
// single result row. Both `status = 'pending'` predicates hit existing partial
// indexes (`idx_jo_pending`, `idx_analytics_events_pending`); `::int` avoids
// bigint-as-string surprises.
export async function queryBacklogDepth(sql: postgres.Sql): Promise<BacklogDepth> {
  return sql.begin(async (tx) => {
    // SET LOCAL scopes the timeout to THIS transaction (safe under PgBouncer
    // transaction pooling); the value is a compile-time integer const (no injection).
    await tx.unsafe(`SET LOCAL statement_timeout = ${BACKLOG_QUERY_STATEMENT_TIMEOUT_MS}`);
    // The leading marker MUST be the first characters of the statement text —
    // PR #502's PoolWedgeReaperPoller identifies reapable read-only backends by
    // an anchored prefix match (query LIKE '/* rw-reapable */%').
    const [row] = await tx<{ job_outbox: number; analytics_events: number }[]>`/* rw-reapable */
      SELECT
        (SELECT COUNT(*)::int FROM job_outbox        WHERE status = 'pending') AS job_outbox,
        (SELECT COUNT(*)::int FROM analytics_events  WHERE status = 'pending') AS analytics_events
    `;
    return {
      job_outbox: row?.job_outbox ?? 0,
      analytics_events: row?.analytics_events ?? 0,
    };
  }) as Promise<BacklogDepth>;
}
