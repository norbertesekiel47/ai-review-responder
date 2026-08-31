import type { Sql, TransactionSql } from 'postgres';
import { anchorReviewLockOrder } from '../../../src/lib/approval/outcomes';
import {
  AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
  AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
  insertAuditLogAutoPolicy,
} from '../../../src/lib/approval/audit';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { AUTO_POST_REVOKED_REFUSAL_CATEGORIES } from '@/lib/refusals/vocabulary';
import { writeRefusalEvent } from '@/lib/refusals/write';
import { enqueueSendNotification } from '../../../src/lib/shared/job-outbox-helpers';
import { markOutboxCompletedIfOwned } from '../../../src/lib/shared/outbox';
// `AutoPolicyDowngradeReason` is DECLARED in `src/lib/shared/worker-types.ts`,
// beside `AutonomySuspensionTrigger` and for the same reason: the Refusal
// ledger's vocabulary maps every member to a **Refusal category**, and no
// production module under `src/lib/` imports from `worker/`. This module still
// owns the downgrade BEHAVIOUR; only the declaration moved, and it is NOT
// re-exported — nothing outside this file has ever imported it (verified at the
// merge base and at head), and `working-rules.md` bans a compatibility shim
// with no named external consumer.
import type { AutoPolicyDowngradeReason } from '../../../src/lib/shared/worker-types';

// One marker per reason for both writes: the audit action AND the
// responses.posting_error value (shared owner: src/lib/approval/audit.ts).
const DOWNGRADE_MARKERS = {
  auto_approval_disabled: AUDIT_ACTION_AUTO_POLICY_REVOKED_BY_KILL_SWITCH,
  notice_undelivered: AUDIT_ACTION_AUTO_POLICY_REVOKED_NOTICE_UNDELIVERED,
  judge_disabled: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  judge_unhealthy: AUDIT_ACTION_AUTO_POLICY_REVOKED_JUDGE_UNAVAILABLE,
  autopilot_entitlement_lost: AUDIT_ACTION_AUTO_POLICY_REVOKED_TIER_ENTITLEMENT,
  policy_suspended: AUDIT_ACTION_AUTO_POLICY_REVOKED_POLICY_SUSPENDED,
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
    //
    // `account_id` RIDES THE LOCK THIS TRANSACTION ALREADY TAKES, and that is a
    // decision rather than a convenience. The Refusal below needs the account
    // key and nothing else in local scope carries it; the alternatives were a
    // second `SELECT account_id` against the same table (which is what
    // `insertAuditLogAutoPolicy` does for its own row) or exporting
    // `resolveAccountIdFromBusiness` from `src/lib/approval/audit.ts`. Both add
    // a query — and a second read — inside a decision transaction, and the
    // hoisted helper additionally returns `''` for a missing business, which is
    // a failure this lane would then have to handle. Widening the column list
    // costs nothing, and the `!lockedBusiness` guard directly below already
    // returns `'no-op'` before any decision is made, so the missing-business
    // case can never reach the ledger. `businesses.account_id` is NOT NULL with
    // an FK to `accounts`, so a locked row cannot carry a null or dangling key.
    //
    // NO COMMENT ABOVE THIS STATEMENT MAY SPELL THIS QUERY'S `FROM` CLAUSE.
    // `auto-policy-downgrade-lock-order.test.ts` resolves each rung of the lock
    // ladder with `body.indexOf(...)` from the previous rung, anchored on that
    // exact phrase — so writing it in a comment resolves the business rung to
    // the COMMENT instead of the query, and the test keeps passing while
    // measuring the wrong line.
    //
    // RED TEAM CAUGHT THIS TWICE: once in the original rationale paragraph
    // above, and once in the FIX for it, which stated the prohibition using the
    // very phrase it forbids and so re-resolved the rung to itself. Hence the
    // indirection in the sentence above; do not "clarify" it by quoting the
    // clause.
    const [lockedBusiness] = await tx<{ id: string; account_id: string }[]>`
      SELECT id, account_id
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

    // The Refusal, on the DECIDING transaction and never its own. It sits after
    // the `!downgraded` guard because a Refusal records a DECISION and a no-op
    // downgrade made none, and beside the audit row because the two are one act:
    // `occurredAt: 'transaction_time'` is `NOW()`, which in Postgres is
    // `transaction_timestamp()`, and `approval_audit_log.created_at` is
    // `DEFAULT NOW()` — so both rows agree to the microsecond and can be joined
    // without an extra column. Never a JS `Date`: postgres.js truncates
    // microseconds on decode (#520) and would kill that join.
    //
    // DELIBERATELY NOT WRAPPED IN try/catch. Migration 116's CHECKs each name a
    // writer bug, and a violation must abort this downgrade rather than be
    // hidden in the one place the ledger cannot report it — the response then
    // stays auto-approved with its outbox attempt un-completed, so the publisher
    // retries. The lever against a writer bug is the helper's own kill switch
    // (`REFUSAL_LEDGER_ENABLED=false`), not a catch here. Duplicates are already
    // safe: the helper's `ON CONFLICT (refusal_source, subject_id) DO NOTHING`
    // means the FIRST Refusal for a response stands and a second downgrade of
    // the same response still commits.
    //
    // The `auto_post_revoked` arm of `WriteRefusalEventInput` fixes every field
    // below — the location, both halves of the subject, both code columns — so
    // this call site does not restate C1–C5.
    await writeRefusalEvent(tx, {
      accountId: lockedBusiness.account_id,
      businessId,
      refusalSource: 'auto_post_revoked',
      // The reason VERBATIM, never normalised. `DOWNGRADE_MARKERS` collapses
      // judge_disabled and judge_unhealthy onto one audit marker and
      // AUTO_POST_REVOKED_REFUSAL_CATEGORIES collapses them onto one category;
      // `refusal_code` is the only place the distinction survives.
      refusalCode: reason,
      allRefusalCodes: null,
      refusalCategory: AUTO_POST_REVOKED_REFUSAL_CATEGORIES[reason],
      // The RESPONSE, never the approval_audit_log row (#1001, superseding
      // #997) — the audit row is written in this same transaction and has an id
      // of its own that would look just as well-formed.
      subjectType: 'response',
      subjectId: responseId,
      occurredAt: 'transaction_time',
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
      policy_suspended: 'account autonomy was suspended before the publish deadline',
    } as const satisfies Record<AutoPolicyDowngradeReason, string>;
    logger.warn(
      `Auto-approved response ${responseId} downgraded to owner review because ${reasonMessages[reason]}`,
    );
    return 'downgraded';
  }
}
