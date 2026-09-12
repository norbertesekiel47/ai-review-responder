// src/lib/admin/business-summary.ts
//
// The single owner of the admin business-summary read (spec
// docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md §5.2).
// It owns, for both admin surfaces:
//
//   - the BASE QUERY — `businesses` × `accounts` × non-superseded `responses`
//     with the pending-approval / pending-reconnect counts and the windowed
//     response aggregates (formerly duplicated by overview-service.ts and
//     businesses-list-service.ts before the §5.2 extraction). It is
//     PAGE-FIRST: the `businesses` × `accounts` candidate set is ordered and
//     LIMIT/OFFSET'd in a CTE BEFORE `responses` is joined, so the response
//     aggregate runs over the page's businesses only — never over every
//     response row in the table just to discard all but one page of groups
//   - the METRICS FOLLOW-UP — the churn-signal CTE, keyed on the ids the base
//     query ACTUALLY returned (post-LIMIT/OFFSET), so the paginated path is
//     bounded by the page and not by the table (§5.4)
//   - `buildBusinessSummary` — the row→DTO mapping, including the churn score
//   - the CONDITIONAL COUNT — the unfiltered total, queried only when a page
//     was requested; unpaginated callers already hold every row.
//
// The Overview service calls it unpaginated and ranks in TypeScript (the churn
// model is TS, not SQL — §5.1); the Businesses API calls it with a page. The
// separate Admin app consumes both through the API.
//
// It is ALSO the owner of the churn DERIVATION for the third admin surface, the
// business DETAIL API: `churnMetricsQuery` and `churnScoreFromMetrics` are
// exported for src/lib/admin/business-detail/*, which spelled both a second time
// until the 2026-08-15 Pathfinder pass (§A2). The detail service reads ONE id, so
// it calls the same query with a one-element array rather than a query of its
// own — the two CTEs were verified semantically identical before merging (the
// multi-id form's GROUP BY + LEFT JOIN + COALESCE produces exactly the row the
// single-id form's CROSS JOIN over ungrouped aggregates produced). Presentation
// of the resulting level now belongs to HealthBadge in the separate Admin app.
//
// Born-injected: `sql` is a parameter, not an import (invariant #15). The
// API composition roots supply the
// singleton, so this module never imports @/lib/db/server.
//
// Strictly SEQUENTIAL per #773 — rows query → (paginated only) COUNT → metrics,
// at most one query in flight. Never a `Promise.all` over `sql`; the fan-out is
// exactly what wedged the Vercel pool in #505. Guarded by
// __tests__/pool-fanout-sequential.test.ts.

import type { Sql } from 'postgres';
import { computeChurnRiskScore, type ChurnScore } from '@/lib/shared/churn-score';
import { HANDLED_STATUSES } from '@/lib/shared/response-status';
import { isSubscriptionStatus, type SubscriptionStatusValue } from '@/lib/shared/subscription-status';
import { buildBusinessFilter, capByHealth, resolveBusinessListParams } from './business-summary-filters';

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
  account_id: string;
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

/**
 * One row of {@link churnMetricsQuery} — the raw churn SIGNALS for one
 * business, before `churnScoreFromMetrics` turns them into a score.
 *
 * `business_id` is present even on the single-id (detail) path: the query is
 * keyed on an id ARRAY so both admin surfaces issue the same statement.
 */
export interface BusinessChurnMetricsRow {
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
  /**
   * The billing parent (invariant #9). Carried so a name search on
   * `GET /api/admin/businesses?q=` can resolve a business to the account id an
   * admin form needs (the CSV import today; impersonation's account lookup is
   * the natural next consumer) without a second endpoint.
   */
  accountId: string;
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
  /**
   * `ChurnScore` by reference, not a structural restatement of it: the level
   * union is `src/lib/shared/churn-score.ts`'s to change; the Admin app's HealthBadge keys
   * its style/label maps on the same type so a new level is a compile error in
   * the UI rather than an unstyled pill.
   */
  churnScore: ChurnScore;
}

export interface BusinessSummariesResult {
  businesses: BusinessSummary[];
  /**
   * The business count under the caller's FILTERS (all businesses when none):
   * the COUNT query when a page was requested, `businesses.length` when not
   * (the caller already read every row), the post-score filtered length when a
   * health filter forced the unpaginated path.
   */
  total: number;
  /** Trailing window (days) that responseRate + avgResponseTimeHours cover. */
  responseMetricsWindowDays: number;
}

/**
 * The churn-signal metrics query for an explicit set of business ids — the
 * SINGLE OWNER of this CTE. Both admin surfaces embed the same statement:
 * `/admin/businesses` + `/admin/overview` pass the ids of the rows they just
 * read, `/admin/businesses/[id]` passes `[businessId]`.
 *
 * Returns a lazy Postgres.js query (the `sql``` tagged template itself), so the
 * CALLER owns the `await` and the sequential-dispatch guarantee stays visible at
 * each call site rather than hiding behind a helper (#773). Never `Promise.all`
 * this with a sibling read.
 *
 * `notif`/`resp` are GROUPed and LEFT JOINed onto the requested id set, so a
 * business with no notifications and no responses still yields a row: every
 * count COALESCEs to 0 and every "last …" signal to NULL, which is what
 * `churnScoreFromMetrics` expects. `account_age_days` comes from the
 * `businesses` join, so an id that does not exist yields no row at all.
 *
 * The 30-day notification window, the ≥3-notification floor under
 * `approval_rate`, and the 7d/35d response-time windows are the churn model's
 * own windows — deliberately NOT `RESPONSE_METRICS_WINDOW_DAYS` above.
 */
export function churnMetricsQuery(sql: Sql, businessIds: string[]) {
  return sql<BusinessChurnMetricsRow[]>`
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
      `;
}

/**
 * Churn signals → churn score — the SINGLE OWNER of the derivation, shared by
 * the summary DTO and the business-detail DTO (§A2 collapsed the second copy).
 *
 * Two steps, both of which have to stay together or the two surfaces can label
 * the same business differently: derive `responseTimeTrend` from the two
 * response-time windows (with the "stopped" fallback for a business that has
 * pending work and has not approved anything in over a week), then hand every
 * signal to the pure formula in src/lib/shared/churn-score.ts.
 *
 * `undefined` metrics — the id produced no row — score as a brand-new account
 * with no signals, which is what the surfaces rendered before this was shared.
 */
export function churnScoreFromMetrics(m: BusinessChurnMetricsRow | undefined): ChurnScore {
  let responseTimeTrend: 'faster_or_stable' | 'slower' | 'stopped' | null = null;
  if (m?.avg_hours_current != null && m?.avg_hours_prev != null) {
    responseTimeTrend = m.avg_hours_current > m.avg_hours_prev * 1.5 ? 'slower' : 'faster_or_stable';
  } else if (m && m.pending_count > 0 && m.days_since_approval != null && m.days_since_approval > 7) {
    responseTimeTrend = 'stopped';
  }

  return computeChurnRiskScore({
    approvalRate: m?.approval_rate ?? null,
    notifiedResponseCount30d: m?.notified_count ?? 0,
    pendingResponseCount: m?.pending_count ?? 0,
    daysSinceLastApproval: m?.days_since_approval ?? null,
    satisfactionResponses: null,
    responseTimeTrend,
    accountAgeDays: m?.account_age_days ?? 0,
  });
}

// buildBusinessSummary maps a nullable DB row to the business-summary DTO. Its
// cyclomatic count (24) is unchanged from main's inline allBusinesses map-callback
// — pre-existing, not introduced here — and is dominated by null-coalescing in the
// object construction (data mapping), not control-flow complexity, so decomposition
// doesn't reduce it. Accepted as inherited debt relocated into a named, test-pinned
// function (the row→DTO characterization tests in __tests__/business-summary.test.ts,
// which came over from the overview suite with buildBusinessSummary, exercise
// every branch).
// fallow-ignore-next-line complexity
function buildBusinessSummary(row: BusinessRow, m: BusinessChurnMetricsRow | undefined): BusinessSummary {
  const responseRate =
    row.total_responses > 0
      ? Math.round((row.completed_responses / row.total_responses) * 100)
      : 0;

  const churnScore = churnScoreFromMetrics(m);

  return {
    id: row.id,
    accountId: row.account_id,
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
 * The churn levels `/admin/businesses` can filter on — `ChurnScore['level']`'s
 * members as a runtime tuple, `satisfies`-checked against the union so a new
 * level upstream is a compile error here, and the route's allowlist for the
 * `health` query param (X5).
 */
export const BUSINESS_HEALTH_FILTERS = ['healthy', 'watch', 'at_risk'] as const satisfies readonly ChurnScore['level'][];
export type BusinessHealthFilter = (typeof BUSINESS_HEALTH_FILTERS)[number];

export function isBusinessHealthFilter(value: string): value is BusinessHealthFilter {
  return (BUSINESS_HEALTH_FILTERS as readonly string[]).includes(value);
}

/** Search / filter inputs for the paginated `/admin/businesses` read (X5). */
export interface BusinessSummariesFilters {
  /** Case-insensitive substring match on `businesses.name`; blank = no filter. Pre-trimmed by the route. */
  search?: string;
  /** Exact `accounts.subscription_status`; blank = no filter. Validated by the route. */
  status?: SubscriptionStatusValue | '';
  /** Churn level; blank = no filter. Applied AFTER scoring — see below. */
  health?: BusinessHealthFilter | '';
}

export interface BusinessSummariesPage extends BusinessSummariesFilters {
  limit: number;
  offset: number;
}

/** Longest name search forwarded to SQL; anything longer is an accident or a probe. */
export const BUSINESS_SEARCH_MAX_LENGTH = 100;

/**
 * The `q` / `status` / `health` query params → validated filters. Shared by
 * `GET /api/admin/businesses` and `businesses/page.tsx` (which reads the same
 * params off `searchParams` for its server-rendered first page), so the two
 * composition roots cannot disagree on what `?status=` means. A value that is
 * not a canonical subscription status or churn level is DROPPED, never
 * forwarded; only present filters appear in the result, so an unfiltered call
 * is byte-identical to `{ limit, offset }`.
 *
 * `limit`/`offset` deliberately stay in the route: their clamping is an HTTP
 * concern the server page never has (it always renders page 0).
 */
export function parseBusinessListFilters(params: URLSearchParams): BusinessSummariesFilters {
  const q = (params.get('q') ?? '').trim().slice(0, BUSINESS_SEARCH_MAX_LENGTH);
  const rawStatus = params.get('status') ?? '';
  const rawHealth = params.get('health') ?? '';
  return {
    ...(q ? { search: q } : {}),
    ...(isSubscriptionStatus(rawStatus) ? { status: rawStatus } : {}),
    ...(isBusinessHealthFilter(rawHealth) ? { health: rawHealth } : {}),
  };
}

/**
 * One page of admin business summaries — or every business when `opts` is
 * omitted — plus the total under the same filters and the response-metrics
 * window.
 *
 * `limit`/`offset` are already-clamped numbers and `search`/`status`/`health`
 * are already validated: query-param parsing stays in the route that owns it.
 *
 * FILTERS (X5). `search` and `status` are SQL predicates inside the `page`
 * CTE, so they bound the page before `responses` is joined and the COUNT
 * counts the same set. `health` cannot be: the churn level is computed in
 * TypeScript from the metrics follow-up (the model is TS, not SQL — §5.1), so
 * a health filter takes the UNPAGINATED path — every row under `search`/
 * `status`, metrics for all of them, score, FILTER on level, THEN slice
 * `limit`/`offset` in TS. That is the same filter-then-cap order the At-risk
 * list uses (docs/context/core-accounts-channels-admin.md → At-risk list) and the same cost Overview already
 * pays on every render; fine at the capacity target (250 locations).
 *
 * The pure steps — request normalisation (`resolveBusinessListParams`), the
 * WHERE fragment (`buildBusinessFilter`) and the health filter-then-cap
 * (`capByHealth`) — live in ./business-summary-filters.ts with their own
 * tests; this function owns the STATEMENTS and their dispatch order.
 *
 * @param sql  Postgres.js client (composition root supplies the singleton —
 *   this module never imports @/lib/db/server).
 */
export async function getBusinessSummaries(
  sql: Sql,
  opts?: BusinessSummariesPage,
): Promise<BusinessSummariesResult> {
  const params = resolveBusinessListParams(opts);

  // Filter predicates live INSIDE the page CTE (before ORDER BY / LIMIT) and are
  // reused verbatim by the COUNT, so the total and the page agree.
  const whereClause = buildBusinessFilter(sql, params);

  // The page is taken in SQL unless a health filter needs every scored row
  // first (see the doc comment). Empty fragment when unpaginated: Overview reads
  // every row because the churn sort is computed in app code from the pure
  // churn-score formula (single owner: churn-score.ts), so ranking can only
  // happen after scoring. Fine at the capacity target (250 locations).
  const pageClause = params.sqlPage
    ? sql`LIMIT ${params.sqlPage.limit} OFFSET ${params.sqlPage.offset}`
    : sql``;

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
  //
  // PAGE-FIRST. The `page` CTE orders and LIMIT/OFFSETs `businesses` × `accounts`
  // BEFORE `responses` is joined, so the aggregate below groups the page's
  // businesses only and `idx_responses_business_status_created` (migration 013)
  // bounds the response scan to those ids. The previous shape joined and
  // aggregated EVERY non-superseded response for EVERY business, then paged the
  // grouped result: `LIMIT` bounded the rows returned, not the work done, and
  // the cost of one /admin/businesses render grew with the whole `responses`
  // table (2026-09 audit). Semantics are unchanged: same aggregate expressions,
  // same LEFT JOIN, same `resp.status != 'superseded'` — only the driving
  // relation moved. `b.id` is the ORDER BY tie-breaker on BOTH sides because a
  // page taken with LIMIT/OFFSET needs a total order or two businesses with the
  // same name can straddle a page boundary and repeat or vanish.
  //
  // Unpaginated (Overview), `page` is every business and the aggregate does the
  // same work it always did — that path reads every business row by design
  // (docs/context/core-accounts-channels-admin.md → At-risk list, §5.1) and is not what this shape optimises.
  const businessRows = await sql<BusinessRow[]>`
    WITH page AS (
      SELECT b.id, b.account_id, b.name, b.category, a.subscription_status, b.last_sync_at
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      ${whereClause}
      ORDER BY b.name ASC, b.id ASC
      ${pageClause}
    )
    SELECT
      b.id, b.account_id, b.name, b.category, b.subscription_status, b.last_sync_at,
      COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count,
      COUNT(CASE WHEN resp.status = 'awaiting_owner_connect' THEN 1 END)::int AS pending_reconnect_count,
      COUNT(resp.id) FILTER (WHERE resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS total_responses,
      COUNT(*) FILTER (WHERE resp.status = ANY(${[...HANDLED_STATUSES] as string[]}::text[]) AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)::int AS completed_responses,
      ROUND(EXTRACT(EPOCH FROM AVG(resp.approved_at - resp.created_at) FILTER (WHERE resp.approved_at IS NOT NULL AND resp.created_at >= CURRENT_DATE - ${RESPONSE_METRICS_WINDOW_DAYS}::int)) / 3600.0, 1)::float AS avg_response_time_hours,
      MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity
    FROM page b
    LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded'
    GROUP BY b.id, b.account_id, b.name, b.category, b.subscription_status, b.last_sync_at
    ORDER BY b.name ASC, b.id ASC
  `;

  // SQL-paginated callers only: an unpaginated caller already holds every row,
  // so `total` is `businesses.length` and this query never runs (§5.3 "drops
  // one query"). Same JOIN + WHERE as the page CTE so the count is over the
  // same filtered set. Not collapsed into a window `COUNT(*) OVER ()`: this
  // page query GROUPs, so a window total would count grouped page rows instead
  // — a different number.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- the awaits ARE independent; that is the point. Parallelising them is the #773 fan-out this module exists to avoid — the shared `sql` pool is 3 connections on Vercel, and a pipelined response wedges a backend permanently.
  const countRows = params.sqlPage
    ? await sql<{ total: number }[]>`
        SELECT COUNT(*)::int AS total FROM businesses b
        JOIN accounts a ON a.id = b.account_id
        ${whereClause}
      `
    : [];

  // Keyed on the ids the base query ACTUALLY RETURNED (post-LIMIT/OFFSET) —
  // the bounded-fetch property of §5.4. An empty page skips the CTE entirely
  // rather than round-tripping an empty UNNEST.
  const businessIds = businessRows.map((r) => r.id);

  const metricsRows = businessIds.length > 0
    ? await churnMetricsQuery(sql, businessIds)
    : [];

  const metricsMap = new Map(metricsRows.map((r) => [r.business_id, r]));
  const scored = businessRows.map((row) => buildBusinessSummary(row, metricsMap.get(row.id)));

  // Under a health filter the page is cut HERE, after scoring (filter THEN
  // cap); otherwise the rows are already the page and the total is the COUNT
  // (paginated) or the row count (unpaginated).
  const { businesses, total } = params.healthPage
    ? capByHealth(scored, params.healthPage)
    : { businesses: scored, total: params.sqlPage ? (countRows[0]?.total ?? 0) : scored.length };

  return { businesses, total, responseMetricsWindowDays: RESPONSE_METRICS_WINDOW_DAYS };
}
