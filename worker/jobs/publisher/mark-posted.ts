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

import type postgres from 'postgres';
import { enqueueAutoPostNotice } from '../../../src/lib/shared/job-outbox-helpers';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import type { WorkerLogger } from '../../../src/lib/shared/logger';

type TxClient = postgres.TransactionSql;

export interface MarkPostedInput {
  tx: TxClient;
  responseId: string;
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
  const { tx, responseId, businessId, correlationId, logger } = input;

  const rows = await tx<{ id: string; approval_method: string | null }[]>`
    UPDATE responses
    SET status = 'posted', posted_at = NOW(), updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    RETURNING id, approval_method
  `;

  // No-op / race retry: the row was already posted (or otherwise not in a
  // publishable state). Never emit a stray FYI.
  if (rows.length !== 1) {
    return { transitioned: false, fyiEnqueued: false };
  }

  // Owner-approved post → no FYI.
  if (rows[0]!.approval_method !== APPROVAL_METHOD.AUTO_POLICY) {
    return { transitioned: true, fyiEnqueued: false };
  }

  await enqueueAutoPostNotice(tx, { responseId, businessId, correlationId });
  logger.log(`Enqueued auto_post_notice FYI for auto-approved response ${responseId}`);
  return { transitioned: true, fyiEnqueued: true };
}
