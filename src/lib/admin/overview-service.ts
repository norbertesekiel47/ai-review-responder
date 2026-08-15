// src/lib/admin/overview-service.ts
//
// Extracted from src/app/api/admin/overview/route.ts's GET body (A+ campaign
// PR 2b). Born-injected: `sql` is a parameter, not an import — the
// composition root (the route) supplies the singleton, so this module never
// imports @/lib/db/server (db-imports-audit baseline stays unchanged).
//
// Runs the 5 system-health queries, derives the email-health redState, and
// builds the AT-RISK LIST (spec §5.1/§5.3). The base query, the churn-metrics
// CTE and `buildBusinessSummary` are NOT here any more: they moved to the
// single owner src/lib/admin/business-summary.ts (§5.2), which this module
// calls unpaginated as its 6th sequential await.
//
// The at-risk list is FILTERED, then sorted, then CAPPED — in that order. It is
// not "top 5 by score": only businesses whose `churnScore.level` is not
// `healthy` are eligible, so an all-healthy account yields `[]` and the client
// renders its empty state rather than five healthy rows under an "At risk"
// heading.

import type { Sql } from 'postgres';
import { getBusinessSummaries, type BusinessSummary } from './business-summary';

/**
 * Admin Overview — at-risk list cap (spec §5.1).
 *
 * Spec §5.1 places this "alongside the existing page sizes in
 * src/app/admin/page-sizes.ts", but `src/lib/**` may not import `@/app/**`
 * (eslint `APP_LEAF_IMPORT_BAN`: "route leaves are terminal"), and the cap is
 * applied HERE — this module is its only consumer, so it is also its only
 * declaration. See the deviations log for the full reasoning:
 * docs/superpowers/plans/refactor-overview-spec-alignment-deviations.md.
 */
export const OVERVIEW_AT_RISK_LIMIT = 5;

interface SystemHealthRow {
  count: number;
}

interface CostRow {
  total: number;
}

interface EmailHealthRow {
  sent_24h: number;
  delivered_24h: number;
  bounces_7d: number;
  hard_bounces_7d: number;
  complaints_7d: number;
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
  /** UNFILTERED business count — the rows just read, not a separate COUNT query. */
  totalBusinesses: number;
  /** Trailing window (days) that responseRate + avgResponseTimeHours cover. */
  responseMetricsWindowDays: number;
  /** At-risk list: level !== 'healthy', ranked, capped at OVERVIEW_AT_RISK_LIMIT. */
  atRisk: BusinessSummary[];
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
export async function getAdminOverview(sql: Sql): Promise<OverviewData> {
  // SEQUENTIAL, one query in flight at a time — do NOT re-introduce a Promise.all
  // of these queries here (#505/#773). They run on the SHARED `sql` client, whose
  // pool is `DB_POOL_MAX` = 3 on Vercel (src/lib/db/server.ts). Fan-out beyond the
  // pool makes postgres.js pipeline the excess queries onto already-open
  // connections over the Supabase Supavisor TRANSACTION pooler; a pipelined
  // query's response parks server-side in state=active / wait_event=ClientRead and
  // is never read — a PERMANENT Connection wedge. No server-side timeout heals it
  // (in ClientRead the statement is not executing, so `statement_timeout` never
  // fires), so each render LEAKS a pool slot until the pool starves and every
  // admin page stops streaming its body while still returning a 200 header.
  //
  // Confirmed live on staging 2026-08-10: wedged backends observed in
  // pg_stat_activity for >3 minutes, including the businesses query
  // getBusinessSummaries now owns, with the admin portal fully unusable. That
  // promotes this file from a #505 audit SUSPECT
  // (fix-505-pool-wedge-rootcause-pipelining-audit-ticket.md:82) to a confirmed
  // instance, and falsifies that ticket's caveat 2 — a Vercel-side wedge is NOT
  // masked by function teardown.
  const pendingOutboxRows = await sql<SystemHealthRow[]>`
    SELECT COUNT(*)::int AS count FROM job_outbox WHERE status = 'pending'
  `;
  const failedJobsRows = await sql<SystemHealthRow[]>`
    SELECT COUNT(*)::int AS count FROM job_outbox WHERE status = 'failed'
  `;
  const todayCostRows = await sql<CostRow[]>`
    SELECT COALESCE(SUM(cost_usd), 0)::float AS total FROM api_costs WHERE created_at >= CURRENT_DATE
  `;
  const notifFailureRows = await sql<SystemHealthRow[]>`
    SELECT COUNT(*)::int AS count FROM notification_deliveries WHERE failed_at IS NOT NULL AND failed_at >= NOW() - INTERVAL '24 hours'
  `;
  const emailHealthRows = await sql<EmailHealthRow[]>`
    SELECT
      COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '24 hours')::int AS sent_24h,
      COUNT(*) FILTER (WHERE delivered_at IS NOT NULL AND sent_at >= NOW() - INTERVAL '24 hours')::int AS delivered_24h,
      COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS bounces_7d,
      COUNT(*) FILTER (WHERE failure_reason LIKE 'bounced:hard:%' AND failed_at >= NOW() - INTERVAL '7 days')::int AS hard_bounces_7d,
      COUNT(*) FILTER (WHERE failure_reason = 'complained' AND failed_at >= NOW() - INTERVAL '7 days')::int AS complaints_7d
    FROM notification_deliveries
  `;

  // UNPAGINATED and the 6th sequential await, never a `Promise.all` member: the
  // churn sort is computed in app code from the pure churn-score formula (single
  // owner: churn-score.ts), so ranking can only happen after scoring. `total`
  // comes back as the rows just read — Overview drops the separate COUNT query
  // it used to issue (§5.3).
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the awaits ARE independent; that is the point. Parallelising them is the #773 fan-out this module exists to avoid — the shared `sql` pool is 3 connections on Vercel, and a pipelined response wedges a backend permanently.
  const { businesses, total, responseMetricsWindowDays } = await getBusinessSummaries(sql);

  // FILTER, then sort, then CAP — in that order. Capping first would surface
  // healthy businesses whenever the first 5 rows happen to be healthy.
  const atRisk = businesses
    .filter((b) => b.churnScore.level !== 'healthy')
    .sort(
      (a, b) =>
        b.churnScore.score - a.churnScore.score ||
        b.pendingApprovalCount - a.pendingApprovalCount ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, OVERVIEW_AT_RISK_LIMIT);

  return {
    systemHealth: {
      pendingOutbox: pendingOutboxRows[0]?.count ?? 0,
      failedJobs: failedJobsRows[0]?.count ?? 0,
      todayCostUsd: todayCostRows[0]?.total ?? 0,
      notificationFailures24h: notifFailureRows[0]?.count ?? 0,
      emailHealth: deriveEmailHealth(emailHealthRows[0]),
    },
    totalBusinesses: total,
    responseMetricsWindowDays,
    atRisk,
  };
}
