import type { Sql, TransactionSql } from 'postgres';
import { anchorReviewLockOrder } from '../../../src/lib/approval/outcomes';
import {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
  insertAuditLogAutoPolicy,
} from '../../../src/lib/approval/audit';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { enqueueSendNotification } from '../../../src/lib/shared/job-outbox-helpers';
import { markOutboxCompletedIfOwned } from '../../../src/lib/shared/outbox';

export type AutoPolicyDowngradeReason =
  | 'auto_approval_disabled'
  | 'notice_undelivered'
  | 'judge_disabled'
  | 'judge_unhealthy'
  | 'autopilot_entitlement_lost';

// One marker per reason for both writes: the audit action AND the
// responses.posting_error value (shared owner: src/lib/approval/audit.ts).
const DOWNGRADE_MARKERS = {
  auto_approval_disabled: AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  notice_undelivered: AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  judge_disabled: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  judge_unhealthy: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  autopilot_entitlement_lost: AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
} as const satisfies Record<AutoPolicyDowngradeReason, string>;

export type AutoPolicyDowngradeOutcome = 'downgraded' | 'no-op';

export interface AutoPolicyDowngradeInput {
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
}

export async function downgradeAutoApprovedResponseForManualReview(
  sql: Sql,
  input: AutoPolicyDowngradeInput,
): Promise<AutoPolicyDowngradeOutcome> {
  return sql.begin((tx) => downgradeAutoApprovedResponseForManualReviewInTx(tx, input));
}

/**
 * Tx-aware body for the publisher entitlement lane. The caller may already
 * hold the review/business/response anchors; the idempotent re-takes preserve
 * one canonical downgrade spine and never open a nested transaction.
 */
export async function downgradeAutoApprovedResponseForManualReviewInTx(
  tx: TransactionSql,
  input: AutoPolicyDowngradeInput,
): Promise<AutoPolicyDowngradeOutcome> {
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

  {
    // In the standalone wrapper this anchor is the transaction's first
    // statement. The entitlement lane already holds the same review, business,
    // and response anchors; re-taking them is idempotent and keeps one canonical
    // downgrade spine.
    const reviewId = await anchorReviewLockOrder(tx, responseId, businessId);
    if (!reviewId) {
      await markOutboxCompletedIfOwned(tx, outboxId, outboxAttempt);
      return 'no-op';
    }

    // Binding lane order continues reviews -> businesses -> responses.
    const [lockedBusiness] = await tx<{ id: string }[]>`
      SELECT id
      FROM businesses
      WHERE id = ${businessId}
      FOR UPDATE
    `;
    if (!lockedBusiness) {
      await markOutboxCompletedIfOwned(tx, outboxId, outboxAttempt);
      return 'no-op';
    }

    const [current] = await tx<{ status: string; approval_method: string | null }[]>`
      SELECT status, approval_method
      FROM responses
      WHERE id = ${responseId}
        AND business_id = ${businessId}
      FOR UPDATE
    `;
    const isDowngradeable = current
      && ['approved', 'edited', 'awaiting_owner_connect'].includes(current.status)
      && current.approval_method === APPROVAL_METHOD.AUTO_POLICY;
    if (!isDowngradeable) {
      await markOutboxCompletedIfOwned(tx, outboxId, outboxAttempt);
      return 'no-op';
    }

    // Claim and complete the exact dispatched attempt before any downgrade
    // fact. The surrounding transaction rolls this CAS back with later writes.
    const ownsAttempt = await markOutboxCompletedIfOwned(tx, outboxId, outboxAttempt);
    if (!ownsAttempt) return 'no-op';

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

    if (!downgraded) return 'no-op';

    // FP: ordered writes inside one sql.begin tx (downgrade UPDATE → audit log → enqueue notification); parallelizing would break tx ordering.
    // react-doctor-disable-next-line react-doctor/async-parallel
    await insertAuditLogAutoPolicy(tx, {
      responseId,
      businessId,
      action: marker,
      responseTextAtApproval: null,
      metadata: {
        downgrade_reason: reason,
        // Every downstream safety gate runs only after the runtime kill-switch
        // passed; only the kill-switch reason itself means the runtime is off.
        runtime_enabled: reason !== 'auto_approval_disabled',
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

    const reasonMessages = {
      auto_approval_disabled: 'auto-approval runtime is disabled',
      notice_undelivered: 'no pending-post notice was delivered',
      judge_disabled: 'the Judge safety watchdog is disabled',
      judge_unhealthy: 'the Judge safety watchdog is unhealthy',
      autopilot_entitlement_lost: 'the account no longer has Autopilot publish entitlement',
    } as const satisfies Record<AutoPolicyDowngradeReason, string>;
    logger.warn(
      `Auto-approved response ${responseId} downgraded to owner review because ${reasonMessages[reason]}`,
    );
    return 'downgraded';
  }
}
