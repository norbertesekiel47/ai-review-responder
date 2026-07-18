// src/lib/dashboard/pending-count.ts
//
// Single authoritative count of owner drafts awaiting approval for a location.
// Excludes held/flagged drafts (the admin queue owns those). Used by BOTH the
// dashboard response (reputationSummary.pendingApprovalCount) and the layout's
// PendingCountProvider seed, so the approvals strip and the mobile tab badge
// can never disagree or over-count (PLAN.md PR2 A.4).

import type { Sql } from 'postgres';

export async function getPendingApprovalCount(sql: Sql, businessId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM responses resp
    WHERE resp.business_id = ${businessId}
      AND resp.status = 'pending_approval'
      AND NOT EXISTS (
        SELECT 1 FROM flagged_responses fr
        WHERE fr.response_id = resp.id AND fr.status = 'open'
      )
  `;
  return row?.count ?? 0;
}

/**
 * Set-based sibling of {@link getPendingApprovalCount}: the same authoritative
 * predicate (`pending_approval` and no open flagged_responses), grouped by
 * `business_id` and account-scoped, so the All-Locations aggregate gets every
 * location's count in ONE query instead of a fan-out. Returns a Map keyed by
 * `business_id`; locations with zero pending drafts are simply absent (callers
 * default them to 0). The explicit `JOIN businesses … account_id` scope is what
 * the tenant-scope audit requires for an account-wide read.
 */
export async function getPendingApprovalCountsForAccount(
  sql: Sql,
  accountId: string,
): Promise<Map<string, number>> {
  const rows = await sql<{ business_id: string; count: number }[]>`
    SELECT resp.business_id, COUNT(*)::int AS count
    FROM responses resp
    JOIN businesses b ON b.id = resp.business_id
    WHERE b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
      AND resp.status = 'pending_approval'
      AND NOT EXISTS (
        SELECT 1 FROM flagged_responses fr
        WHERE fr.response_id = resp.id AND fr.status = 'open'
      )
    GROUP BY resp.business_id
  `;

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.business_id, Number(row.count));
  }
  return counts;
}
