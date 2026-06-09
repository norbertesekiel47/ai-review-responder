import { sql } from '../../../src/lib/db/server';
import { insertAuditLogAutoPolicy } from '../../../src/lib/approval/audit';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { enqueueSendNotification } from '../../../src/lib/shared/job-outbox-helpers';
import { markOutboxCompleted } from '../../../src/lib/shared/outbox';

const AUTO_POLICY_REVOKED_BY_KILL_SWITCH =
  'auto_policy_revoked_by_kill_switch';

export type AutoPolicyDowngradeOutcome = 'downgraded' | 'no-op';

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
      await markOutboxCompleted(outboxId, outboxAttempt, tx);
      return 'no-op';
    }

    // FP: ordered writes inside one sql.begin tx (downgrade UPDATE → audit log → enqueue notification); parallelizing would break tx ordering.
    // react-doctor-disable-next-line react-doctor/async-parallel
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

    await enqueueSendNotification(tx, {
      responseId,
      businessId,
      correlationId,
    });

    await markOutboxCompleted(outboxId, outboxAttempt, tx);
    logger.warn(
      `Auto-approved response ${responseId} downgraded to owner review because auto-approval runtime is disabled`,
    );
    return 'downgraded';
  });
}
