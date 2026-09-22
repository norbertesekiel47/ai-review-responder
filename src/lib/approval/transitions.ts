// src/lib/approval/transitions.ts
//
// Single owner for each `responses` status-transition UPDATE that every
// approval mode (token, session, callback) performs (#1367). Before this
// module, the same `status='approved' / 'edited' / 'superseded'` column
// list was hand-copied into token-mode.ts, session-mode.ts, and
// callback-mode.ts — a future schema or semantics change risked landing on
// one copy and not the others, on the most safety-critical write in the
// system (invariant #3: no unapproved posting).
//
// Each mode keeps its own locking (locks.ts), link-revocation, outcome
// recording, and audit semantics — this module owns ONLY the column list
// for a given transition. Callers MUST already hold the response row lock
// (via lockPendingResponse) before calling here; these functions do not
// lock and do not validate `status`.

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
