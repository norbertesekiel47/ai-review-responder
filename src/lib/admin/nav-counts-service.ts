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
  const [flaggedRows, failedRows] = await Promise.all([
    sql<CountRow[]>`SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'`,
    sql<CountRow[]>`SELECT COUNT(*)::int AS total FROM job_outbox WHERE status = 'failed'`,
  ]);
  return {
    flaggedOpen: flaggedRows[0]?.total ?? 0,
    failedJobs: failedRows[0]?.total ?? 0,
  };
}
