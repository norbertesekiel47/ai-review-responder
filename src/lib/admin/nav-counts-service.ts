import type { Sql } from 'postgres';

export interface AdminNavCounts {
  /** flagged_responses awaiting admin disposition (status = 'open'). */
  flaggedOpen: number;
  /** job_outbox rows in terminal failure (status = 'failed'). */
  failedJobs: number;
}

interface CountRow {
  total: number;
}

/**
 * Sidebar badge counts (spec §2). Two intentionally cross-tenant aggregate
 * COUNTs — admin-only, behind requireRoleOr401(admin) at the route.
 */
export async function getAdminNavCounts(sql: Sql): Promise<AdminNavCounts> {
  // SEQUENCED, NOT `Promise.all` — at most ONE query in flight (#773). See
  // src/lib/admin/flagged-service.ts for the mechanism. The two counts are
  // independent, so sequencing changes no result.
  const flaggedRows = await sql<CountRow[]>`SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'`;
  const failedRows = await sql<CountRow[]>`SELECT COUNT(*)::int AS total FROM job_outbox WHERE status = 'failed'`;
  return {
    flaggedOpen: flaggedRows[0]?.total ?? 0,
    failedJobs: failedRows[0]?.total ?? 0,
  };
}
