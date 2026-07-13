import type { Sql } from 'postgres';
import {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  insertAuditLogAutoPolicy,
} from '../../../src/lib/approval/audit';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { enqueueSendNotification } from '../../../src/lib/shared/job-outbox-helpers';
import { markOutboxCompleted } from '../../../src/lib/shared/outbox';

export type AutoPolicyDowngradeReason =
  | 'auto_approval_disabled'
  | 'notice_undelivered';

// One marker per reason for both writes: the audit action AND the
// responses.posting_error value (shared owner: src/lib/approval/audit.ts).
const DOWNGRADE_MARKERS = {
  auto_approval_disabled: AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  notice_undelivered: AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
} as const satisfies Record<AutoPolicyDowngradeReason, string>;

export type AutoPolicyDowngradeOutcome = 'downgraded' | 'no-op';

export async function downgradeAutoApprovedResponseForManualReview(sql: Sql, input: {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  correlationId: string | undefined;
  /**
   * Why the auto-policy approval is being revoked. Defaults to the original
   * kill-switch reason so the existing caller is unchanged;
   * 'notice_undelivered' is the publisher's spec-§2.11 notice-delivery gate.
   */
  reason?: AutoPolicyDowngradeReason;
  logger: { warn(message: string): void };
}): Promise<AutoPolicyDowngradeOutcome> {
  const {
    responseId,
    businessId,
    outboxId,
    outboxAttempt,
    correlationId,
    reason = 'auto_approval_disabled',
    logger,
  } = input;
  const marker = DOWNGRADE_MARKERS[reason];

  return sql.begin(async (tx) => {
    const [downgraded] = await tx<{ id: string }[]>`
      UPDATE responses
      SET status = 'pending_approval',
          approval_method = NULL,
          approved_at = NULL,
          approved_text = NULL,
          posting_error = ${marker},
          updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
        AND approval_method = ${APPROVAL_METHOD.AUTO_POLICY}
      RETURNING id
    `;

    if (!downgraded) {
      await markOutboxCompleted(tx, outboxId, outboxAttempt);
      return 'no-op';
    }

    // FP: ordered writes inside one sql.begin tx (downgrade UPDATE → audit log → enqueue notification); parallelizing would break tx ordering.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await insertAuditLogAutoPolicy(tx, {
      responseId,
      businessId,
      action: marker,
      responseTextAtApproval: null,
      metadata: {
        downgrade_reason: reason,
        // The notice-undelivered gate only runs while the runtime flag is ON;
        // the kill-switch reason by definition means it is OFF.
        runtime_enabled: reason === 'notice_undelivered',
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

    await markOutboxCompleted(tx, outboxId, outboxAttempt);
    logger.warn(
      reason === 'notice_undelivered'
        ? `Auto-approved response ${responseId} downgraded to owner review because no pending-post notice was delivered`
        : `Auto-approved response ${responseId} downgraded to owner review because auto-approval runtime is disabled`,
    );
    return 'downgraded';
  });
}
