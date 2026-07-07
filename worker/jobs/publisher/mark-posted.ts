// worker/jobs/publisher/mark-posted.ts
//
// Shared "mark posted (+ maybe enqueue the auto-post FYI)" transition for the
// publisher (Codex R1 #1 / R2 #2 / R2 #3). BOTH terminal success paths — the
// fresh 2xx post AND the 409 text-match recovery in verify409AndDispose — call
// this INSIDE one sql.begin() tx, so the status flip + the FYI enqueue are
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

export async function markPostedAndMaybeEnqueueAutoPostNotice(
  input: MarkPostedInput,
): Promise<MarkPostedResult> {
  const { tx, responseId, reviewId, businessId, correlationId, logger } = input;

  // Take the review row lock as the transaction's FIRST statement (run-spine.ts
  // lock-ordering contract). Both callers open their sql.begin() with this
  // helper as the tx's only statement, so this lock is genuinely tx statement
  // #1: it precedes the responses UPDATE below (whose row FK-references the
  // review) and the agent_runs row locks taken by recordStep/completeRun,
  // serializing at the review row against concurrent ingest/persist/edit txs.
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

  const approvalMethod = rows[0]!.approval_method;
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
