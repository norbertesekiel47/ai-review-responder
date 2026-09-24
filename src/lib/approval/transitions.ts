// src/lib/approval/transitions.ts
//
// Owner of the `responses` status-transition UPDATE column lists for the
// approve/edit/supersede family (#1367, extended #1454). Started as the
// owner-approval lane's three modes ONLY (token-mode.ts, session-mode.ts,
// callback-mode.ts) — their `status='approved' / 'edited' / 'superseded'`
// UPDATEs were byte-identical. #1454 folded in every OTHER 'approved' /
// 'superseded' writer whose column list could be centralized without
// reshaping its guard, RETURNING, or lock order — see the per-function docs
// below for what each caller was and what changed.
//
// updated_at: the three original functions did NOT set it (no DB trigger
// backfills it — no `CREATE TRIGGER` touches `responses` in
// supabase/migrations/), while every other writer in the codebase already
// does. #1454 added `updated_at = NOW()` to all three — no reader depends on
// the prior omission (checked: nothing orders or filters `responses` by
// `updated_at` except an unrelated offboarding-retry table's own column of
// the same name; the transition time is separately recorded on
// `approval_audit_log` / outcome rows, which this change does not touch).
//
// NOT a repo-wide owner. Left hand-spelled, each for a stated reason:
//   - `src/app/api/dashboard/past-replies/publish/route.ts` — `status` is a
//     SQL `CASE` (approve vs. edit) decided from `edited_text IS NOT NULL`
//     in ONE atomic UPDATE; this module's functions each commit to a single
//     literal status and don't model a dynamic status expression.
//   - `worker/jobs/publisher/edit-publish-tx.ts` (`supersedeSibling`,
//     `markCandidateOrThrow`, `markCandidatePermanentFailedInTx`) and
//     `edit-publish-errors.ts` (the mismatch-after-DELETE inline UPDATE, and
//     `markCandidateOrThrow`'s `setBody: postgres.Fragment` composition) —
//     already the local, multi-caller owner of the guarded-UPDATE-or-throw
//     shape for the edit-publisher DELETE-before-POST flow; one UPDATE's SQL
//     text is deliberately byte-pinned against a nesting-depth twin from a
//     prior fallow complexity dedup (see that file's comment), and
//     `supersedeSibling` doesn't carry `businessId` in its signature at all
//     — reshaping it to route through `ResponseTarget` would touch every one
//     of its several callers for a non-safety-relevant column-list dedup.
//   - `worker/jobs/zernio/zernio-ingest-shared.ts` — a bulk
//     `WHERE id = ANY(uuid[])` UPDATE over many response rows from one
//     review-reconciliation pass, with a bulk `RETURNING id` used for a
//     count log; a fundamentally different (set-based, no single
//     `businessId`) statement shape than every function below.
//
// Each mode/caller keeps its own locking, link-revocation, outcome
// recording, and audit semantics — this module owns ONLY the column list
// (and, where a caller needs one, a parameterized guard) for a given
// transition. It does not decide what a guard-miss means for the caller —
// functions that return RETURNING rows leave the throw/rollback decision to
// the caller. All three owner-approval-lane modes' locks trace back to
// locks.ts's `lockPendingResponse`, reached directly (session-mode) or
// through a local claim helper that also consumes the link (token-mode's
// `lockAndConsumeTokenResponse`, callback-mode's `claimCallbackResponse`).

import type postgres from 'postgres';
import { APPROVAL_METHOD, type ApprovalMethod } from '@/lib/auto-approval/types';

// `Sql | TransactionSql` (not just `TransactionSql`) — matches the
// `SqlExecutor` union used elsewhere in the codebase (e.g.
// `src/lib/account-offboarding/gate.ts`, `src/lib/payments/plan-activation.ts`).
// Needed because `markResponseSupersededByExternalReply`'s caller
// (`verify409AndDispose`) runs the UPDATE on a bare connection, not inside an
// open `sql.begin()` transaction.
type TxClient = postgres.Sql | postgres.TransactionSql;

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
        posting_error = NULL,
        updated_at = NOW()
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
        posting_error = NULL,
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;
}

/**
 * Mark a response superseded — a regeneration was requested, or (as of
 * #1454) the draft is simply being abandoned with no reason recorded.
 * Callers own revoking sibling links and enqueueing `generate_response`
 * around this call where relevant; this only flips `status`.
 *
 * Callers as of #1454: the owner-approval lane's three modes (regenerate);
 * `process-review.ts`'s "other statuses — supersede and regenerate" branch;
 * `admin/flagged/route.ts`'s `requires_regeneration` disposition; and the
 * owner's past-replies draft-cancel `DELETE`. None of those needed a
 * `posting_error` or a status guard — see `markResponseSupersededWithReason`
 * for the two callers that do.
 */
export async function markResponseSuperseded(
  tx: TxClient,
  { responseId, businessId }: ResponseTarget,
): Promise<void> {
  await tx`
    UPDATE responses
    SET status = 'superseded',
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;
}

/**
 * Mark a response approved during owner recovery-retry
 * (`past-replies/[responseId]/retry/route.ts`). Differs from
 * `markResponseApproved` in two ways the retry flow requires:
 *   - `approved_text` uses `COALESCE(approved_text, response_text)` — a
 *     prior attempt may already have backfilled it, and overwriting it with
 *     a possibly-stale `response_text` would lose an owner edit.
 *   - `posting_error` is caller-computed, not always cleared: recovering a
 *     `post_after_delete_failed_*` row must RE-INSTALL the
 *     `PENDING_AFTER_DELETE` orphan marker (not `NULL`) so the publisher
 *     retries via the no-DELETE branch.
 * No status guard — the caller already re-read and locked the row
 * (`status !== 'failed'` check) earlier in the same transaction.
 */
export async function markResponseApprovedRecovery(
  tx: TxClient,
  {
    responseId,
    businessId,
    method,
    postingError,
  }: ResponseTarget & { method: ApprovalMethod; postingError: string | null },
): Promise<void> {
  await tx`
    UPDATE responses
    SET status = 'approved',
        posting_error = ${postingError},
        approval_method = ${method},
        approved_at = NOW(),
        approved_text = COALESCE(approved_text, response_text),
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;
}

/**
 * The auto-policy approve UPDATE for `approveAutoPolicyAndSchedule`
 * (`worker/jobs/response-generation/persist.ts`). Guarded by
 * `status = 'pending_approval'` (a concurrent kill-switch downgrade or veto
 * can win the race) and stamps `auto_post_scheduled_at` from the veto-window
 * minutes; returns the `RETURNING` rows so the caller decides what a
 * guard-miss means (today: roll back the transaction and let generation-job
 * retry semantics cover it) — this module does not throw on the caller's
 * behalf.
 */
export async function markResponseApprovedAutoPolicy(
  tx: TxClient,
  {
    responseId,
    businessId,
    responseText,
    vetoWindowMinutes,
  }: ResponseTarget & { responseText: string; vetoWindowMinutes: number },
): Promise<{ auto_post_scheduled_at: Date }[]> {
  return tx<{ auto_post_scheduled_at: Date }[]>`
    UPDATE responses
    SET status = 'approved',
        approval_method = ${APPROVAL_METHOD.AUTO_POLICY},
        approved_text = ${responseText},
        approved_at = NOW(),
        auto_post_scheduled_at = NOW() + make_interval(mins => ${vetoWindowMinutes}),
        posting_error = NULL,
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status = 'pending_approval'
    RETURNING auto_post_scheduled_at
  `;
}

/**
 * Mark a response superseded with a caller-supplied `posting_error` reason —
 * used where a response is abandoned with a recorded cause rather than
 * actively regenerated: a parked (`awaiting_owner_connect`) draft whose
 * review changed underneath it (`process-review.ts`), or an admin giving up
 * on a stuck parked draft (`admin/businesses/[id]/zernio-queue/route.ts`
 * `dismiss`).
 *
 * `guardStatus`, when given, adds `AND status = guardStatus`. The one caller
 * that passes it (the zernio-queue dismiss) already re-validated the row's
 * status under its own `FOR UPDATE` immediately before calling this in the
 * same transaction, so the guard is defense-in-depth, not the sole race
 * protection — matching this module's stated policy of not owning status
 * validation itself, just executing whatever guard the caller supplies.
 */
export async function markResponseSupersededWithReason(
  tx: TxClient,
  {
    responseId,
    businessId,
    postingError,
    guardStatus,
  }: ResponseTarget & { postingError: string; guardStatus?: string },
): Promise<void> {
  if (guardStatus !== undefined) {
    await tx`
      UPDATE responses
      SET status = 'superseded',
          posting_error = ${postingError},
          updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status = ${guardStatus}
    `;
    return;
  }
  await tx`
    UPDATE responses
    SET status = 'superseded',
        posting_error = ${postingError},
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;
}

/**
 * Supersede a response because the customer's external reply on Google
 * text-mismatches ours (`publisher-error-handlers.ts`'s 409 verify-first
 * path, `verify409AndDispose`). Guard mirrors the edit-publisher candidate
 * lock's publishable-status set (`approved`, `edited`,
 * `awaiting_owner_connect`) — a response outside that set was never
 * publishable, so there is nothing to supersede. No RETURNING/count-check:
 * the caller proceeds to `markOutboxCompleted` regardless (a lost race here
 * just means a later verifier pass, or the sibling's own terminal path,
 * already handled it).
 */
export async function markResponseSupersededByExternalReply(
  tx: TxClient,
  { responseId, businessId }: ResponseTarget,
): Promise<void> {
  await tx`
    UPDATE responses
    SET status = 'superseded',
        posting_error = 'already_replied_external',
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect') -- status-audit-ignore: state-transition UPDATE guard, intentionally inline per response-status.ts header
  `;
}

/**
 * Supersede an auto-policy response after a confirmed provider-side mismatch
 * (`auto-policy-publish.ts`'s `supersedeProviderMismatch` — the review
 * already has a DIFFERENT reply on Google than ours). Clears every
 * approval-lane column an auto-policy approve had set, since the approval it
 * represents never reached Google. Guard covers `pending_approval` in
 * addition to the publishable set — this lane can supersede a row before it
 * was ever approved. Returns the `RETURNING` row count so the caller can
 * detect a lost race and throw its own error (this module does not decide
 * what a guard-miss means for the caller).
 */
export async function markResponseSupersededProviderMismatch(
  tx: TxClient,
  { responseId, businessId }: ResponseTarget,
): Promise<{ count: number }> {
  const result = await tx`
    UPDATE responses
    SET status = 'superseded',
        approval_method = NULL,
        approved_text = NULL,
        approved_at = NULL,
        auto_post_scheduled_at = NULL,
        posting_error = 'already_replied_external',
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect') -- status-audit-ignore: state-transition UPDATE guard, intentionally inline per response-status.ts header
    RETURNING 1
  `;
  return { count: result.count };
}
