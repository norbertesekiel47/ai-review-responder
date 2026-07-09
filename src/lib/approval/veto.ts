// src/lib/approval/veto.ts
//
// Owner veto of a scheduled auto-post (WS4 spec §2.6). The pending
// publish_response outbox row is the atomicity token: the veto succeeds IFF
// this tx terminalizes that row while it is still 'pending' — the OutboxPoller
// claims with FOR UPDATE SKIP LOCKED, so whoever locks first wins and there is
// no state where Google has the reply after the owner saw "cancelled".
//
// Deliberately NOT lockPendingResponse: that claim primitive requires
// status='pending_approval' and rejects archived locations, but a veto targets
// an APPROVED response and must remain possible on an archived location —
// cancelling an outbound post reduces exposure and must never fail closed.
// The inline FOR UPDATE below keeps the uniform approval-lane lock order
// (responses row first, everything else after).

import type postgres from 'postgres';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { enqueueSendNotification } from '@/lib/shared/job-outbox-helpers';
import { findActiveReviewRun, recordOutcome } from '@/lib/agents/run-spine';
import { insertAuditLog, type AuditContext } from './audit';
import { consumeLink } from './locks';
import type { ApprovalLink } from './types';

type TxClient = postgres.TransactionSql;

export const AUTO_POST_VETOED_BY_OWNER = 'auto_post_vetoed_by_owner';

export type VetoAutoPostResult = 'cancelled' | 'already_cancelled' | 'too_late';

export async function vetoAutoPost(
  tx: TxClient,
  link: ApprovalLink,
  audit: AuditContext,
  correlationId?: string,
): Promise<VetoAutoPostResult> {
  const responseId = link.response_id;
  const businessId = link.business_id;

  // Lock the response first (uniform approval-lane order: responses → rest).
  const [resp] = await tx<{
    status: string; approval_method: string | null;
    posting_error: string | null; review_id: string;
  }[]>`
    SELECT status, approval_method, posting_error, review_id
    FROM responses
    WHERE id = ${responseId} AND business_id = ${businessId}
    FOR UPDATE
  `;
  if (!resp) return 'too_late';

  if (!(resp.status === 'approved' && resp.approval_method === APPROVAL_METHOD.AUTO_POLICY)) {
    return resp.status === 'pending_approval' && resp.posting_error === AUTO_POST_VETOED_BY_OWNER
      ? 'already_cancelled'
      : 'too_late';
  }

  // The atomic kill. 0 rows ⇒ the publisher already claimed it — too late.
  const [killed] = await tx<{ id: string }[]>`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW(), last_error = ${AUTO_POST_VETOED_BY_OWNER}
    WHERE topic = ${QUEUE_NAMES.PUBLISH_RESPONSE}
      AND aggregate_id = ${responseId}
      AND status = 'pending'
    RETURNING id
  `;
  if (!killed) return 'too_late';

  const [downgraded] = await tx<{ id: string }[]>`
    UPDATE responses
    SET status = 'pending_approval',
        approval_method = NULL,
        approved_at = NULL,
        approved_text = NULL,
        auto_post_scheduled_at = NULL,
        posting_error = ${AUTO_POST_VETOED_BY_OWNER},
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status = 'approved'
      AND approval_method = ${APPROVAL_METHOD.AUTO_POLICY}
    RETURNING id
  `;
  if (!downgraded) {
    // Impossible while we hold the response lock — defensive rollback.
    throw new Error('veto_downgrade_lost_response');
  }

  await consumeLink(tx, link.id);

  const activeRun = await findActiveReviewRun(tx, resp.review_id);
  if (activeRun) {
    await recordOutcome(tx, {
      runId: activeRun.id,
      accountId: activeRun.account_id,
      businessId,
      attributedAgent: 'reply',
      outcomeKind: 'reply_vetoed_by_owner',
    });
  }

  await insertAuditLog(tx, responseId, businessId, 'veto_cancel', audit, {
    correlation_id: correlationId,
  });

  // Kill-switch-downgrade parity: the draft goes back to the normal approval
  // lane with fresh links, so it is actionable from the owner's channel.
  await enqueueSendNotification(tx, { responseId, businessId, correlationId });

  return 'cancelled';
}
