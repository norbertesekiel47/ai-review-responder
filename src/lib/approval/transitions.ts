// src/lib/approval/transitions.ts
//
// Owner of the `responses` status-transition UPDATE for the owner-approval
// lane's three modes ONLY — token-mode.ts, session-mode.ts, callback-mode.ts
// (#1367). Their `status='approved' / 'edited' / 'superseded'` UPDATEs were
// byte-identical; this is now the one place that column list is spelled,
// on the most safety-critical write in the system (invariant #3).
//
// NOT a repo-wide owner: the past-replies retry/publish routes, the
// auto-policy approve in worker/jobs/response-generation/persist.ts, and
// ~11 other 'superseded' sites still hand-spell their own UPDATE and (unlike
// these three functions) also set `updated_at = NOW()` — tracked as #1454,
// not folded in here because each of those sites diverges in a way that
// makes the fold a design decision, not a mechanical one.
//
// Each mode keeps its own locking, link-revocation, outcome recording, and
// audit semantics — this module owns ONLY the column list for a given
// transition, and does not lock or validate `status` itself. All three
// modes' locks trace back to locks.ts's `lockPendingResponse`, reached
// directly (session-mode) or through a local claim helper that also
// consumes the link (token-mode's `lockAndConsumeTokenResponse`,
// callback-mode's `claimCallbackResponse`).

import type postgres from 'postgres';
import type { ApprovalMethod } from '@/lib/auto-approval/types';

type TxClient = postgres.TransactionSql;

interface ResponseTarget {
  responseId: string;
  businessId: string;
}

/**
 * Mark a response approved as-is (no owner edits).
 * `approved_text` is set to the current `response_text` (the draft as
 * generated); `posting_error` is cleared so a stale failure from a prior
 * attempt never blocks the next publish.
 */
export async function markResponseApproved(
  tx: TxClient,
  { responseId, businessId, method }: ResponseTarget & { method: ApprovalMethod },
): Promise<void> {
  await tx`
    UPDATE responses
    SET status = 'approved',
        approval_method = ${method},
        approved_at = NOW(),
        approved_text = response_text,
        posting_error = NULL
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;
}

/**
 * Mark a response approved WITH owner edits. `approved_text` and
 * `edited_text` both receive the sanitized edited text; `edit_distance` is
 * the caller-computed Levenshtein distance from the original draft.
 *
 * Every current caller passes `method: APPROVAL_METHOD.OWNER` — edits are
 * an owner-only action — but `method` stays an explicit required param
 * rather than defaulting, so a future caller cannot silently inherit the
 * wrong value on this safety-critical write.
 */
export async function markResponseEdited(
  tx: TxClient,
  {
    responseId,
    businessId,
    method,
    editedText,
    editDistance,
  }: ResponseTarget & { method: ApprovalMethod; editedText: string; editDistance: number },
): Promise<void> {
  await tx`
    UPDATE responses
    SET status = 'edited',
        approval_method = ${method},
        approved_at = NOW(),
        approved_text = ${editedText},
        edited_text = ${editedText},
        edit_distance = ${editDistance},
        posting_error = NULL
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;
}

/**
 * Mark a response superseded — a regeneration was requested. Callers own
 * revoking sibling links and enqueueing `generate_response` around this
 * call; this only flips `status`.
 */
export async function markResponseSuperseded(
  tx: TxClient,
  { responseId, businessId }: ResponseTarget,
): Promise<void> {
  await tx`
    UPDATE responses
    SET status = 'superseded'
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;
}
