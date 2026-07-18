// src/lib/admin/overview-service.ts
//
// Extracted from src/app/api/admin/overview/route.ts's GET body (A+ campaign
// PR 2b). Born-injected: `sql` is a parameter, not an import — the
// composition root (the route) supplies the singleton, so this module never
// imports @/lib/db/server (db-imports-audit baseline stays unchanged).
//
// Runs the 7 parallel dashboard-summary queries, the conditional
// churn-metrics CTE (skipped when there are no businesses), the churn-score
// computation + descending sort + pagination, and the email-health redState
// derivation. Behavior-preserving extraction — same queries, same status
// literals, same shape.

import type { Sql } from 'postgres';
import { computeChurnRiskScore } from '@/lib/shared/churn-score';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';

// Response-rate and average-response-time are reported over a trailing window so
// the admin churn view reflects RECENT responsiveness rather than a lifetime
// average diluted by history (and so those aggregates don't grow unboundedly
// over the years). This is the SINGLE OWNER of the window: it is applied to the
// businessRows FILTERs below AND surfaced on OverviewData.responseMetricsWindowDays
// so the UI column labels derive from the same number. It is deliberately NOT the
// same concept as the churn-metrics CTE's own 7/30/35-day signal windows below.
const RESPONSE_METRICS_WINDOW_DAYS = 30;

interface SystemHealthRow {
  count: number;
}

interface CostRow {
  total: number;
}

interface BusinessRow {
  id: string;
  name: string;
  subscription_status: string;
  last_sync_at: Date | null;
  pending_approval_count: number;
  pending_reconnect_count: number;
  total_responses: number;
  completed_responses: number;
  avg_response_time_hours: number | null;
  last_activity: Date | null;
}

interface EmailHealthRow {
  sent_24h: number;
  delivered_24h: number;
  bounces_7d: number;
  hard_bounces_7d: number;
  complaints_7d: number;
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

interface BusinessSummary {
  id: string;
  name: string;
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

interface EmailHealthSummary {
  sent24h: number;
  delivered24h: number;
  bounces7d: number;
  hardBounces7d: number;
  complaints7d: number;
  deliveryRate24h: number;
  redState: boolean;
}

export interface OverviewData {
  systemHealth: {
    pendingOutbox: number;
    failedJobs: number;
    todayCostUsd: number;
    notificationFailures24h: number;
    emailHealth: EmailHealthSummary;
  };
  totalBusinesses: number;
  limit: number;
  offset: number;
  /** Trailing window (days) that responseRate + avgResponseTimeHours cover. */
  responseMetricsWindowDays: number;
  businesses: BusinessSummary[];
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

// Derives the email-health summary (delivery rate + redState) from the raw
// notification_deliveries aggregate row. Extracted from getAdminOverview
// (behavior-preserving, A+ campaign PR 2b).
// Red state: delivery rate < 95% with at least 5 sends, OR any complaint in
// 7d, OR any hard bounce in 7d.
// Same estimated-coverage CRAP artifact as buildBusinessSummary above — this
// is a flat, already-minimal defaulting + boolean derivation pinned by the
// 6 redState characterization tests in overview-service.test.ts.
// fallow-ignore-next-line complexity
function deriveEmailHealth(eh: EmailHealthRow | undefined): EmailHealthSummary {
  const sent24h = eh?.sent_24h ?? 0;
  const delivered24h = eh?.delivered_24h ?? 0;
  const deliveryRate24h = sent24h > 0 ? Math.round((delivered24h / sent24h) * 100) : 100;
  const bounces7d = eh?.bounces_7d ?? 0;
  const hardBounces7d = eh?.hard_bounces_7d ?? 0;
  const complaints7d = eh?.complaints_7d ?? 0;

  const redState =
    (sent24h >= 5 && deliveryRate24h < 95) ||
    complaints7d > 0 ||
    hardBounces7d > 0;

  return {
    sent24h,
    delivered24h,
    bounces7d,
    hardBounces7d,
    complaints7d,
    deliveryRate24h,
    redState,
  };
}

/**
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function getAdminOverview(
  sql: Sql,
  params: { limit: number; offset: number },
): Promise<OverviewData> {
  const { limit, offset } = params;

  const [
    pendingOutboxRows,
    failedJobsRows,
    todayCostRows,
    notifFailureRows,
    emailHealthRows,
    businessRows,
    businessCountRows,
  ] = await Promise.all([
    sql<SystemHealthRow[]>`
      SELECT COUNT(*)::int AS count FROM job_outbox WHERE status = 'pending'
    `,
    sql<SystemHealthRow[]>`
      SELECT COUNT(*)::int AS count FROM job_outbox WHERE status = 'failed'
    `,
    sql<CostRow[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::float AS total FROM api_costs WHERE created_at >= CURRENT_DATE
    `,
    sql<SystemHealthRow[]>`
      SELECT COUNT(*)::int AS count FROM notification_deliveries WHERE failed_at IS NOT NULL AND failed_at >= NOW() - INTERVAL '24 hours'
    `,
    sql<EmailHealthRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '24 hours')::int AS sent_24h,
        COUNT(*) FILTER (WHERE delivered_at IS NOT NULL AND sent_at >= NOW() - INTERVAL '24 hours')::int AS delivered_24h,
        COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS bounces_7d,
        COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:hard:%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS hard_bounces_7d,
        COUNT(*) FILTER (WHERE failure_reason = 'complained' AND failed_at >= NOW() - INTERVAL '7 days')::int AS complaints_7d
      FROM notification_deliveries
    `,
    // Fetch ALL businesses (no LIMIT/OFFSET): the churn sort is computed in app
    // code from the pure churn-score formula (single owner: churn-score.ts), so
    // pagination can only happen after scoring. Fine at the capacity target
    // (250 locations). total_responses / completed_responses / avg_response_time
    // are windowed to the trailing RESPONSE_METRICS_WINDOW_DAYS (recent
    // responsiveness); pending/reconnect counts and last_activity stay ALL-TIME —
    // old still-pending items and a dormant business's last activity are the churn
    // signals and must not be windowed away.
    sql<BusinessRow[]>`
      SELECT
        b.id, b.name, a.subscription_status, b.last_sync_at,
        COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count,
        COUNT(CASE WHEN resp.status = 'awaiting_owner_connect' THEN 1 END)::int AS pending_reconnect_count,
        COUNT(resp.id) FILTER (WHERE resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS total_responses,
        COUNT(*) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS completed_responses,
        ROUND(EXTRACT(EPOCH FROM AVG(resp.approved_at - resp.created_at) FILTER (WHERE resp.approved_at IS NOT NULL AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)) / 3600.0, 1)::float AS avg_response_time_hours,
        MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded'
      GROUP BY b.id, b.name, a.subscription_status, b.last_sync_at
    `,
    sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM businesses`,
  ]);

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

  // Map all businesses with churn scores, sort by risk descending, then paginate
  const allBusinesses = businessRows.map((row) => buildBusinessSummary(row, metricsMap.get(row.id)));

  // Sort by risk score descending (most at-risk first), then paginate
  allBusinesses.sort(
    (a, b) =>
      b.churnScore.score - a.churnScore.score ||
      b.pendingApprovalCount - a.pendingApprovalCount ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  const paginatedBusinesses = allBusinesses.slice(offset, offset + limit);

  return {
    systemHealth: {
      pendingOutbox: pendingOutboxRows[0]?.count ?? 0,
      failedJobs: failedJobsRows[0]?.count ?? 0,
      todayCostUsd: todayCostRows[0]?.total ?? 0,
      notificationFailures24h: notifFailureRows[0]?.count ?? 0,
      emailHealth: deriveEmailHealth(emailHealthRows[0]),
    },
    totalBusinesses: businessCountRows[0]?.total ?? 0,
    limit,
    offset,
    responseMetricsWindowDays: RESPONSE_METRICS_WINDOW_DAYS,
    businesses: paginatedBusinesses,
  };
}
