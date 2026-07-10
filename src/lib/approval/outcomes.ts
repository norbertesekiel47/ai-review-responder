// src/lib/approval/outcomes.ts
//
// WS4 spec §2.8: owner-decision outcome instrumentation shared by the five
// approval chokepoints (session/token approve + edit, callback approve).
// Regenerate lanes record no outcome and take no anchor — a regenerate is
// not an owner verdict on the draft.

import type postgres from 'postgres';
import { findActiveReviewRun, recordOutcome } from '@/lib/agents/run-spine';

type TxClient = postgres.TransactionSql;

/**
 * Global lock-order anchor for approval-lane transactions that record an
 * outcome (veto.ts precedent — its header owns the deadlock analysis):
 * recordOutcome's INSERT takes an implicit FK FOR KEY SHARE on the
 * agent_runs row, while a concurrent processReview holds reviews(X) →
 * agent_runs(X) via recordStep and then waits on the SAME response row the
 * approval lane locks via lockPendingResponse. Serializing at the review row
 * FIRST makes the relative response/run lock order irrelevant.
 *
 * Call this BEFORE any response lock: (1) UNLOCKED pre-read resolves the
 * review id (review_id is immutable on responses, so it cannot go stale);
 * (2) reviews FOR UPDATE — unchecked result, transitions.ts posture. A
 * missing response row skips the lock and returns: the caller's claim
 * primitive (lockPendingResponse) then throws its normal not-found error.
 */
export async function anchorReviewLockOrder(
  tx: TxClient,
  responseId: string,
  businessId: string,
): Promise<void> {
  const [preRead] = await tx<{ review_id: string }[]>`
    SELECT review_id FROM responses
    WHERE id = ${responseId} AND business_id = ${businessId}
  `;
  if (!preRead) return;

  await tx`
    SELECT id FROM reviews
    WHERE id = ${preRead.review_id} AND business_id = ${businessId}
    FOR UPDATE
  `;
}

/** Emit the owner-decision outcome for a review's running run, if any (WS4
 *  spec §2.8). Legacy/no-run reviews skip silently — established posture.
 *  Caller contract: the tx MUST hold the review row FOR UPDATE (taken before
 *  the response lock — anchorReviewLockOrder above; see veto.ts's lock-order
 *  header) because recordOutcome takes an agent_runs FK KEY SHARE that
 *  cycles with recordStep holders. */
export async function recordOwnerDecisionOutcome(
  tx: TxClient,
  input: {
    reviewId: string;
    businessId: string;
    outcomeKind: 'reply_approved_no_edit' | 'reply_edited_by_owner';
  },
): Promise<void> {
  const activeRun = await findActiveReviewRun(tx, input.reviewId);
  if (!activeRun) return;
  await recordOutcome(tx, {
    runId: activeRun.id,
    accountId: activeRun.account_id,
    businessId: input.businessId,
    attributedAgent: 'reply',
    outcomeKind: input.outcomeKind,
  });
}
