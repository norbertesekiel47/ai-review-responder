import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { jsonb, sql } from '../../../src/lib/db/server';
import { insertAuditLogAutoPolicy } from '../../../src/lib/approval/audit';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import type { SendNotificationPayload } from '../../../src/lib/shared/worker-types';

type TxClient = postgres.TransactionSql;

const AGGREGATE_TYPE_RESPONSE = 'response';
const JOB_OUTBOX_STATUS_DISPATCHED = 'dispatched';
const JOB_OUTBOX_STATUS_COMPLETED = 'completed';

export const AUTO_POLICY_REVOKED_BY_KILL_SWITCH =
  'auto_policy_revoked_by_kill_switch';

export type AutoPolicyDowngradeOutcome = 'downgraded' | 'no-op';

async function markPublishOutboxCompletedTx(
  tx: TxClient,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  if (typeof outboxAttempt === 'number' && Number.isFinite(outboxAttempt)) {
    await tx`
      UPDATE job_outbox
      SET status = ${JOB_OUTBOX_STATUS_COMPLETED}, completed_at = NOW()
      WHERE id = ${outboxId}
        AND status = ${JOB_OUTBOX_STATUS_DISPATCHED}
        AND attempts = ${outboxAttempt}
    `;
    return;
  }

  await tx`
    UPDATE job_outbox
    SET status = ${JOB_OUTBOX_STATUS_COMPLETED}, completed_at = NOW()
    WHERE id = ${outboxId}
      AND status = ${JOB_OUTBOX_STATUS_DISPATCHED}
  `;
}

export async function downgradeAutoApprovedResponseForManualReview(input: {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  correlationId: string | undefined;
  logger: { warn(message: string): void };
}): Promise<AutoPolicyDowngradeOutcome> {
  const {
    responseId,
    businessId,
    outboxId,
    outboxAttempt,
    correlationId,
    logger,
  } = input;

  return sql.begin(async (tx) => {
    const [downgraded] = await tx<{ id: string }[]>`
      UPDATE responses
      SET status = 'pending_approval',
          approval_method = NULL,
          approved_at = NULL,
          approved_text = NULL,
          posting_error = ${AUTO_POLICY_REVOKED_BY_KILL_SWITCH},
          updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
        AND approval_method = ${APPROVAL_METHOD.AUTO_POLICY}
      RETURNING id
    `;

    if (!downgraded) {
      await markPublishOutboxCompletedTx(tx, outboxId, outboxAttempt);
      return 'no-op';
    }

    await insertAuditLogAutoPolicy(tx, {
      responseId,
      businessId,
      action: AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
      responseTextAtApproval: null,
      metadata: {
        downgrade_reason: 'auto_approval_disabled',
        runtime_enabled: false,
        outbox_id: outboxId,
        outbox_attempt: outboxAttempt,
        correlation_id: correlationId,
      },
    });

    const notifyPayload: SendNotificationPayload = {
      response_id: responseId,
      business_id: businessId,
    };
    if (correlationId !== undefined) {
      notifyPayload.correlation_id = correlationId;
    }

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()},
        ${QUEUE_NAMES.SEND_NOTIFICATION},
        ${AGGREGATE_TYPE_RESPONSE},
        ${responseId},
        ${jsonb(notifyPayload)},
        'pending'
      )
    `;

    await markPublishOutboxCompletedTx(tx, outboxId, outboxAttempt);
    logger.warn(
      `Auto-approved response ${responseId} downgraded to owner review because auto-approval runtime is disabled`,
    );
    return 'downgraded';
  });
}
