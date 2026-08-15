// src/lib/admin/business-summary.ts
//
// The single owner of the admin business-summary read (spec
// docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md §5.2).
// It owns, for both admin surfaces:
//
//   - the BASE QUERY — `businesses` × `accounts` × non-superseded `responses`
//     with the pending-approval / pending-reconnect counts and the windowed
//     response aggregates (today spelled identically in overview-service.ts and
//     businesses-list-service.ts, which is the duplication §5.2 removes)
//   - the METRICS FOLLOW-UP — the churn-signal CTE, keyed on the ids the base
//     query ACTUALLY returned (post-LIMIT/OFFSET), so the paginated path is
//     bounded by the page and not by the table (§5.4)
//   - `buildBusinessSummary` — the row→DTO mapping, including the churn score
//   - the CONDITIONAL COUNT — the unfiltered total, queried only when a page
//     was requested; unpaginated callers already hold every row.
//
// Overview calls it unpaginated and ranks the result in TypeScript (the churn
// model is TS, not SQL — §5.1); Businesses calls it with a page. One owner, so
// the two pages cannot disagree on how a business is counted, scored or labelled.
//
// Born-injected: `sql` is a parameter, not an import (invariant #15). The
// composition roots (the two routes and the two server pages) supply the
// singleton, so this module never imports @/lib/db/server.
//
// Strictly SEQUENTIAL per #773 — rows query → (paginated only) COUNT → metrics,
// at most one query in flight. Never a `Promise.all` over `sql`; the fan-out is
// exactly what wedged the Vercel pool in #505. Guarded by
// __tests__/pool-fanout-sequential.test.ts.

import type { Sql } from 'postgres';
import { computeChurnRiskScore } from '@/lib/shared/churn-score';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';

// Response-rate and average-response-time are reported over a trailing window so
// the admin churn view reflects RECENT responsiveness rather than a lifetime
// average diluted by history (and so those aggregates don't grow unboundedly
// over the years). This is the SINGLE OWNER of the window: it is applied to the
// businessRows FILTERs below AND surfaced on
// BusinessSummariesResult.responseMetricsWindowDays so the UI column labels
// derive from the same number. It is deliberately NOT the same concept as the
// churn-metrics CTE's own 7/30/35-day signal windows below.
const RESPONSE_METRICS_WINDOW_DAYS = 30;

interface BusinessRow {
  id: string;
  name: string;
  category: string | null;
  subscription_status: string;
  last_sync_at: Date | null;
  pending_approval_count: number;
  pending_reconnect_count: number;
  total_responses: number;
  completed_responses: number;
  avg_response_time_hours: number | null;
  last_activity: Date | null;
}

interface BusinessMetricsRow {
  business_id: string;
  approval_rate: number | null;
  notified_count: number;
  pending_count: number;
  days_since_approval: number | null;
  account_age_days: number;
  avg_hours_current: number | null;
  avg_hours_prev: number | null;
}

export interface BusinessSummary {
  id: string;
  name: string;
  category: string | null;
  subscriptionStatus: string;
  lastSyncAt: string | null;
  pendingApprovalCount: number;
  pendingReconnectCount: number;
  totalResponses: number;
  completedResponses: number;
  responseRate: number;
  avgResponseTimeHours: number | null;
  lastActivity: string | null;
  churnScore: {
    score: number;
    level: 'healthy' | 'watch' | 'at_risk';
    breakdown: Array<{ signal: string; value: string; contribution: number }>;
  };
}

export interface BusinessSummariesResult {
  businesses: BusinessSummary[];
  /**
   * The UNFILTERED business count: the COUNT query when a page was requested,
   * `businesses.length` when not (the caller already read every row).
   */
  total: number;
  /** Trailing window (days) that responseRate + avgResponseTimeHours cover. */
  responseMetricsWindowDays: number;
}

// buildBusinessSummary maps a nullable DB row to the business-summary DTO. Its
// cyclomatic count (24) is unchanged from main's inline allBusinesses map-callback
// — pre-existing, not introduced here — and is dominated by null-coalescing in the
// object construction (data mapping), not control-flow complexity, so decomposition
// doesn't reduce it. Accepted as inherited debt relocated into a named, test-pinned
// function (the overview characterization tests exercise every branch).
// fallow-ignore-next-line complexity
function buildBusinessSummary(row: BusinessRow, m: BusinessMetricsRow | undefined): BusinessSummary {
  const responseRate =
    row.total_responses > 0
      ? Math.round((row.completed_responses / row.total_responses) * 100)
      : 0;

  let responseTimeTrend: 'faster_or_stable' | 'slower' | 'stopped' | null = null;
  if (m?.avg_hours_current != null && m?.avg_hours_prev != null) {
    responseTimeTrend = m.avg_hours_current > m.avg_hours_prev * 1.5 ? 'slower' : 'faster_or_stable';
  } else if (m && m.pending_count > 0 && m.days_since_approval != null && m.days_since_approval > 7) {
    responseTimeTrend = 'stopped';
  }

  const churnScore = computeChurnRiskScore({
    approvalRate: m?.approval_rate ?? null,
    notifiedResponseCount30d: m?.notified_count ?? 0,
    pendingResponseCount: m?.pending_count ?? 0,
    daysSinceLastApproval: m?.days_since_approval ?? null,
    satisfactionResponses: null,
    responseTimeTrend,
    accountAgeDays: m?.account_age_days ?? 0,
  });

  return {
    id: row.id,
    name: row.name,
    category: row.category ?? null,
    subscriptionStatus: row.subscription_status,
    lastSyncAt: row.last_sync_at ? row.last_sync_at.toISOString() : null,
    pendingApprovalCount: row.pending_approval_count,
    pendingReconnectCount: row.pending_reconnect_count,
    totalResponses: row.total_responses,
    completedResponses: row.completed_responses,
    responseRate,
    avgResponseTimeHours: row.avg_response_time_hours ?? null,
    lastActivity: row.last_activity ? row.last_activity.toISOString() : null,
    churnScore,
  };
}

/**
 * One page of admin business summaries — or every business when `opts` is
 * omitted — plus the unfiltered total and the response-metrics window.
 *
 * `limit`/`offset` are already-clamped numbers: query-param parsing stays in
 * the route that owns it.
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function getBusinessSummaries(
  sql: Sql,
  opts?: { limit: number; offset: number },
): Promise<BusinessSummariesResult> {
  // Empty fragment when unpaginated: Overview reads every row because the churn
  // sort is computed in app code from the pure churn-score formula (single
  // owner: churn-score.ts), so ranking can only happen after scoring. Fine at
  // the capacity target (250 locations).
  const pageClause = opts ? sql`LIMIT ${opts.limit} OFFSET ${opts.offset}` : sql``;

  // SEQUENTIAL, one query in flight at a time — do NOT re-introduce a
  // Promise.all of these queries here (#505/#773). These run on the SHARED
  // `sql` client, whose pool is `DB_POOL_MAX` = 3 on Vercel
  // (src/lib/db/server.ts). Fan-out beyond the pool makes postgres.js pipeline
  // the excess queries onto already-open connections over the Supabase
  // Supavisor TRANSACTION pooler; a pipelined query's response parks
  // server-side in state=active / wait_event=ClientRead and is never read — a
  // PERMANENT Connection wedge. No server-side timeout heals it (in ClientRead
  // the statement is not executing, so `statement_timeout` never fires), so
  // each render LEAKS a pool slot until the pool starves and every admin page
  // stops streaming its body while still returning a 200 header.
  //
  // Confirmed live on staging 2026-08-10: wedged backends observed in
  // pg_stat_activity for >3 minutes, including this businesses query, with the
  // admin portal fully unusable.
  //
  // total_responses / completed_responses / avg_response_time are windowed to
  // the trailing RESPONSE_METRICS_WINDOW_DAYS (recent responsiveness);
  // pending/reconnect counts and last_activity stay ALL-TIME — old still-pending
  // items and a dormant business's last activity are the churn signals and must
  // not be windowed away.
  const businessRows = await sql<BusinessRow[]>`
    SELECT
      b.id, b.name, b.category, a.subscription_status, b.last_sync_at,
      COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count,
      COUNT(CASE WHEN resp.status = 'awaiting_owner_connect' THEN 1 END)::int AS pending_reconnect_count,
      COUNT(resp.id) FILTER (WHERE resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS total_responses,
      COUNT(*) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS completed_responses,
      ROUND(EXTRACT(EPOCH FROM AVG(resp.approved_at - resp.created_at) FILTER (WHERE resp.approved_at IS NOT NULL AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)) / 3600.0, 1)::float AS avg_response_time_hours,
      MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded'
    GROUP BY b.id, b.name, b.category, a.subscription_status, b.last_sync_at
    ORDER BY b.name ASC
    ${pageClause}
  `;

  // Paginated callers only: the unpaginated caller already holds every row, so
  // `total` is `businesses.length` and this query never runs (§5.3 "drops one
  // query"). Not collapsed into a window `COUNT(*) OVER ()`: this page query
  // GROUPs and the count is over unfiltered `businesses`, so a window total
  // would count grouped page rows instead — a different number.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the awaits ARE independent; that is the point. Parallelising them is the #773 fan-out this module exists to avoid — the shared `sql` pool is 3 connections on Vercel, and a pipelined response wedges a backend permanently.
  const countRows = opts
    ? await sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM businesses`
    : [];

  // Keyed on the ids the base query ACTUALLY RETURNED (post-LIMIT/OFFSET) —
  // the bounded-fetch property of §5.4. An empty page skips the CTE entirely
  // rather than round-tripping an empty UNNEST.
  const businessIds = businessRows.map((r) => r.id);

  const metricsRows = businessIds.length > 0
    ? await sql<BusinessMetricsRow[]>`
        WITH biz AS (SELECT UNNEST(${businessIds}::uuid[]) AS id),
        notif AS (
          SELECT nd.business_id,
                 COUNT(DISTINCT nd.response_id)::int AS notified_count,
                 COUNT(DISTINCT nd.response_id) FILTER (
                   WHERE r.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[])
                 )::int AS approved_count
          FROM notification_deliveries nd
          JOIN responses r ON r.id = nd.response_id
          WHERE nd.business_id IN (SELECT id FROM biz)
            AND nd.template = 'approval_request'
            AND nd.sent_at IS NOT NULL
            AND nd.sent_at >= CURRENT_DATE - 30
          GROUP BY nd.business_id
        ),
        resp AS (
          SELECT rp.business_id,
                 COUNT(*) FILTER (WHERE rp.status = 'pending_approval')::int AS pending_count,
                 EXTRACT(DAY FROM CURRENT_TIMESTAMP - MAX(rp.approved_at)
                   FILTER (WHERE rp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]))
                 )::int AS days_since_approval,
                 AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0)
                   FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 7)::float AS avg_hours_current,
                 AVG(EXTRACT(EPOCH FROM rp.approved_at - rp.created_at) / 3600.0)
                   FILTER (WHERE rp.approved_at IS NOT NULL AND rp.created_at >= CURRENT_DATE - 35 AND rp.created_at < CURRENT_DATE - 7)::float AS avg_hours_prev
          FROM responses rp
          WHERE rp.business_id IN (SELECT id FROM biz)
          GROUP BY rp.business_id
        )
        SELECT
          b.id AS business_id,
          CASE WHEN COALESCE(n.notified_count, 0) >= 3
               THEN n.approved_count::float / NULLIF(n.notified_count, 0)
               ELSE NULL END AS approval_rate,
          COALESCE(n.notified_count, 0)::int AS notified_count,
          COALESCE(rp.pending_count, 0)::int AS pending_count,
          rp.days_since_approval,
          EXTRACT(DAY FROM CURRENT_TIMESTAMP - bs.created_at)::int AS account_age_days,
          rp.avg_hours_current,
          rp.avg_hours_prev
        FROM biz b
        JOIN businesses bs ON bs.id = b.id
        LEFT JOIN notif n ON n.business_id = b.id
        LEFT JOIN resp rp ON rp.business_id = b.id
      `
    : [];

  const metricsMap = new Map(metricsRows.map((r) => [r.business_id, r]));
  const businesses = businessRows.map((row) => buildBusinessSummary(row, metricsMap.get(row.id)));

  return {
    businesses,
    total: opts ? (countRows[0]?.total ?? 0) : businesses.length,
    responseMetricsWindowDays: RESPONSE_METRICS_WINDOW_DAYS,
  };
}
