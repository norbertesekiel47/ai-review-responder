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
