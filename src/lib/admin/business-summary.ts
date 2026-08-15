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
//
// T1 (TDD RED): the exported types are real so `pnpm typecheck` and the eval
// suite are stable; the body lands in T2. The `_`-prefixed parameters are the
// house opt-out for an intentionally unused binding — T2 drops the underscore
// when the queries arrive.

import type { Sql } from 'postgres';

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

/**
 * One page of admin business summaries — or every business when `opts` is
 * omitted — plus the unfiltered total and the response-metrics window.
 *
 * `limit`/`offset` are already-clamped numbers: query-param parsing stays in
 * the route that owns it.
 */
export async function getBusinessSummaries(
  _sql: Sql,
  _opts?: { limit: number; offset: number },
): Promise<BusinessSummariesResult> {
  throw new Error('T2: not implemented');
}
