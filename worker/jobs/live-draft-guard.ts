// Live-draft guard for the terminal-failure run checkpoints (WS5 spec §3).
//
// A terminal failure on ONE lane does not always end the review's handling:
// a v2 regen can exhaust its budget while the v1 draft still awaits the
// owner. Completing the run 'failed' in that state makes the timeline lie
// ("Failed" while a draft is owner-actionable) and strands the eventual
// post's spine writes (no active run). Checkpoints therefore skip completeRun
// while a live owner-actionable response exists — the run stays running and
// renders waiting_on_owner.
//
// Caller contract (lock-order law): call inside the checkpoint tx AFTER the
// reviews FOR UPDATE lock. reviews → responses is the canonical order, and
// the held reviews lock makes this plain read stable — every response
// status-transition tx takes the reviews lock first.

import type { TransactionSql } from 'postgres';
import { NON_TERMINAL_STATUSES } from '../../src/lib/shared/response-status';

/**
 * True when the review still has a response the owner can act on
 * (NON_TERMINAL_STATUSES: pending_approval / approved / edited /
 * awaiting_owner_connect — the partial unique index allows at most one).
 * A superseded/posted/failed row is not live.
 */
export async function hasLiveOwnerActionableResponse(
  tx: TransactionSql,
  reviewId: string,
  businessId: string,
): Promise<boolean> {
  const liveRows = await tx`
    SELECT 1 FROM responses
    WHERE review_id = ${reviewId}
      AND business_id = ${businessId}
      AND status = ANY(${[...NON_TERMINAL_STATUSES] as string[]}::text[])
    LIMIT 1
  `;
  return liveRows.length > 0;
}
