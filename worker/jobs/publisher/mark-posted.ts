// worker/jobs/publisher/mark-posted.ts
//
// Shared "mark posted (+ maybe enqueue the auto-post FYI)" transition for the
// publisher (Codex R1 #1 / R2 #2 / R2 #3). EVERY terminal success path — the
// fresh 2xx post, the fresh-lane 409 text-match recovery in
// verify409AndDispose, the edit-publish step-7 success (WS4 §2.9), and the
// edit-lane 409 text-match recovery in edit-publish-errors — calls this
// INSIDE one sql.begin() tx, so the status flip + the FYI enqueue are
// atomic (invariant #2: never write Postgres then separately enqueue, or the
// FYI is silently lost on enqueue failure / retry-after-409).
//
// Affected-row guard (R2 #3): the FYI is enqueued ONLY when the UPDATE actually
// transitions exactly one row AND that row is approval_method='auto_policy'. A
// no-op / race retry (row already posted) transitions ZERO rows → no stray FYI;
// it is also backed by the per-response in-flight outbox uniqueness guard in
// enqueueAutoPostNotice (migration 067). Owner-approved posts get NO FYI — the
// owner clicked Approve, so they already know.
//
// This module also owns the run spine's terminal checkpoint: on a real
// transition it records the reply_posted step, the reply_posted (and, for
// auto_policy, reply_auto_posted) outcome, and completes the review's run —
// all in the same tx, behind the reviews FOR UPDATE lock taken first.

import * as Sentry from '@sentry/node';
import type postgres from 'postgres';
import { revokeOpenLinksForResponse } from '../../../src/lib/approval/locks';
import { enqueueAutoPostNotice } from '../../../src/lib/shared/job-outbox-helpers';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import {
  completeRun,
  findActiveReviewRun,
  recordOutcome,
  recordStep,
} from '../../../src/lib/agents/run-spine';
import type { WorkerLogger } from '../../../src/lib/shared/logger';

type TxClient = postgres.TransactionSql;

export interface MarkPostedInput {
  tx: TxClient;
  responseId: string;
  /** The review the response replies to — locked FOR UPDATE as tx statement #1. */
  reviewId: string;
  businessId: string;
  correlationId?: string;
  logger: WorkerLogger;
}

export interface MarkPostedResult {
  /** True when exactly one approved/edited/awaiting row transitioned to posted. */
  transitioned: boolean;
  /** True when an auto_post_notice FYI was enqueued in this tx. */
  fyiEnqueued: boolean;
}

export interface RecoverAutoPolicyProviderTruthInput extends MarkPostedInput {
  /** Durable auto-approval text; provider truth must never depend on job payload text. */
  approvedText: string;
  /** Original auto-policy approval instant from approval_audit_log. */
  approvedAt: Date;
}

export async function markPostedAndMaybeEnqueueAutoPostNotice(
  input: MarkPostedInput,
): Promise<MarkPostedResult> {
  const { tx, responseId, reviewId, businessId, logger } = input;

  // Review row lock (run-spine.ts lock-ordering contract). CALLER CONTRACT:
  // every caller's tx must hold the reviews FOR UPDATE before any other
  // statement that locks the review row. The two fresh-lane callers
  // (ResponsePublisherWorker 2xx, verify409AndDispose) open their sql.begin()
  // with this helper as the tx's only statement, so this lock IS tx statement
  // #1 there; the two edit-lane callers (edit-publish step 7, the edit-lane
  // 409 recovery) run mid-tx and already hold the lock from edit-publish's
  // step 1, making this an idempotent same-tx re-take. Either way it precedes
  // the responses UPDATE below (whose row FK-references the review) and the
  // agent_runs row locks taken by recordStep/completeRun, serializing at the
  // review row against concurrent ingest/persist/edit txs.
  const [reviewLock] = await tx<{ id: string }[]>`
    SELECT id FROM reviews
    WHERE id = ${reviewId} AND business_id = ${businessId}
    FOR UPDATE
  `;
  if (!reviewLock) {
    // Response references a review not visible to its business — impossible if
    // FKs hold (caller bug / corrupt state only). The lock no-oped, so the
    // ordering contract is void for this tx; surface loudly (same posture as
    // failed-hook.ts's orphan_response_review) but proceed — the status-guarded
    // UPDATE below safely matches zero-or-one rows regardless.
    Sentry.captureMessage('orphan_response_review', {
      level: 'warning',
      extra: {
        response_id: responseId,
        review_id: reviewId,
        business_id: businessId,
        site: 'mark-posted',
      },
    });
    logger.warn(
      `Review ${reviewId} not found for business ${businessId} — mark-posted review lock no-oped (response ${responseId})`,
    );
  }

  const rows = await tx<{ id: string; approval_method: string | null }[]>`
    UPDATE responses
    SET status = 'posted', posted_at = NOW(), updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    RETURNING id, approval_method
  `;

  // No-op / race retry: the row was already posted (or otherwise not in a
  // publishable state). Never emit a stray FYI — and never re-append spine
  // steps for a transition that already happened.
  if (rows.length !== 1) {
    return { transitioned: false, fyiEnqueued: false };
  }

  return finalizePostedTransition(input, rows[0]!.approval_method);
}

/**
 * Repairs local truth after a provider-attempt ambiguity is later confirmed as
 * our auto-policy reply. An intervening veto/downgrade may have cleared the
 * approval fields, but it cannot make the already-public provider reply cease
 * to exist. The caller has already CAS-claimed the outbox attempt and holds the
 * review -> business -> response lane.
 */
export async function recoverAutoPolicyProviderTruth(
  input: RecoverAutoPolicyProviderTruthInput,
): Promise<MarkPostedResult> {
  const {
    tx,
    responseId,
    businessId,
    approvedText,
    approvedAt,
  } = input;
  const rows = await tx<{ id: string }[]>`
    UPDATE responses
    SET status = 'posted',
        approval_method = ${APPROVAL_METHOD.AUTO_POLICY},
        approved_text = ${approvedText},
        approved_at = ${approvedAt},
        posted_at = COALESCE(posted_at, NOW()),
        posting_error = NULL,
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status IN ('pending_approval', 'approved', 'edited', 'awaiting_owner_connect')
    RETURNING id
  `;
  if (rows.length !== 1) {
    throw new Error(
      `Confirmed provider reply could not repair response ${responseId} from its current state`,
    );
  }
  return finalizePostedTransition(input, APPROVAL_METHOD.AUTO_POLICY);
}

async function finalizePostedTransition(
  input: MarkPostedInput,
  approvalMethod: string | null,
): Promise<MarkPostedResult> {
  const { tx, responseId, reviewId, businessId, correlationId, logger } = input;

  // The pending-post notice mints approval links for auto-approved responses;
  // once posted, no live link should remain actionable-looking. (A concurrent
  // veto tx orders links→reviews while this tx orders reviews→links; the rare
  // collision is resolved by the deadlock detector and both sides retry
  // safely — veto re-taps, this job re-runs through the 409 recovery path.)
  await revokeOpenLinksForResponse(tx, responseId);

  const isAutoPolicy = approvalMethod === APPROVAL_METHOD.AUTO_POLICY;

  // Run-spine checkpoint: the reply reached Google — record the terminal step
  // + outcome(s) and complete the run, atomically with the status flip. A null
  // run means a legacy review ingested before the spine existed → skip.
  const activeRun = await findActiveReviewRun(tx, reviewId);
  if (activeRun) {
    await recordStep(tx, {
      runId: activeRun.id,
      stepKey: 'reply_posted',
      detail: { response_id: responseId, approval_method: approvalMethod },
    });
    await recordOutcome(tx, {
      runId: activeRun.id,
      accountId: activeRun.account_id,
      businessId,
      attributedAgent: 'reply',
      outcomeKind: 'reply_posted',
    });
    if (isAutoPolicy) {
      await recordOutcome(tx, {
        runId: activeRun.id,
        accountId: activeRun.account_id,
        businessId,
        attributedAgent: 'reply',
        outcomeKind: 'reply_auto_posted',
      });
    }
    await completeRun(tx, activeRun.id, 'completed');
  }

  // Owner-approved post → no FYI.
  if (!isAutoPolicy) {
    return { transitioned: true, fyiEnqueued: false };
  }

  await enqueueAutoPostNotice(tx, { responseId, businessId, correlationId });
  logger.log(`Enqueued auto_post_notice FYI for auto-approved response ${responseId}`);
  return { transitioned: true, fyiEnqueued: true };
}
