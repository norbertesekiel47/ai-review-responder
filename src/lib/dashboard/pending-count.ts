import { sql } from '@/lib/db/server';

// Single authoritative count of owner-visible drafts awaiting approval for one
// location. Used by BOTH the PendingCountProvider seed in the authenticated
// layout (tabbar badge on cold loads of any route) AND the /api/dashboard
// reputation summary (the on-dashboard PendingApprovalsStrip), so the strip and
// the badge can never disagree.
//
// "Owner-visible" excludes drafts with an OPEN flagged_responses row: a
// high-severity moderation flag holds the draft in the admin queue and it must
// never surface to the owner UI (architecture invariant #4). The prior layout
// seed counted a raw `status='pending_approval'`, which over-counted by
// including these held drafts.
export async function getPendingApprovalCount(businessId: string): Promise<number> {
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
