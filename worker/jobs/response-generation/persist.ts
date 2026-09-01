// worker/jobs/response-generation/persist.ts
//
// Invariant #4 transactional boundary for the response generator. Persists the
// generated response, links its api_costs row(s), records moderation metadata,
// and — for a high-severity moderation flag — HOLDS the draft (writes a
// flagged_responses row and skips the send_notification outbox enqueue) in the
// SAME transaction as response persistence. The moderation-hold + notification
// skip must never split from the INSERT. See CLAUDE.md invariant #4.

import { v7 as uuidv7 } from 'uuid';
import * as Sentry from '@sentry/node';
import type postgres from 'postgres';
import type { ModerationDecision } from '../../../src/lib/moderation/output-filter';
import type { GenerationResult } from '../../../src/lib/responses/types';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import { resolveDailyCap } from '../../../src/lib/auto-approval/policy';
import {
  GENERATE_RESPONSE_ORIGIN_LANE,
  type GenerateResponseOriginLane,
} from '../../../src/lib/shared/worker-types';
import { OUTBOX_COMPLETION_REASON } from '../../../src/lib/shared/outbox-completion-reason';
import {
  enqueuePendingPostNotice,
  enqueuePublishResponse,
  enqueueSendNotification,
} from '../../../src/lib/shared/job-outbox-helpers';
import {
  insertAuditLogAutoPolicy,
  type AutoPolicyAuditMetadata,
} from '../../../src/lib/approval/audit';
import {
  findActiveReviewRun,
  recordOutcome,
  recordStep,
} from '../../../src/lib/agents/run-spine';
import {
  HELD_DRAFT_REFUSAL_CATEGORY,
  resolvePolicyGateRefusal,
} from '../../../src/lib/refusals/vocabulary';
import { REFUSAL_LEDGER_FLAG, writeRefusalEvent } from '../../../src/lib/refusals/write';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import { acquireTierEntitlementLock } from '../../../src/lib/accounts/billing-locks';
import type { SubscriptionTierValue } from '../../../src/lib/accounts/tier-config';
import {
  type AutoApprovalDecision,
  type AutoApprovalRuntimeState,
  evaluateAutoApprovalCandidate,
  isAutoApprovalCandidate,
  loadAutoApprovalRuntimeState,
  structurallyBlockedDecision,
} from './auto-approval';

const RESPONSE_STATUS_PENDING_APPROVAL = 'pending_approval';
const RESPONSE_STATUS_APPROVED = 'approved';
const FLAGGED_RESPONSE_STATUS_OPEN = 'open';

export interface PersistResponseInput {
  result: GenerationResult;
  /** api_costs row for the avoid-facts RETRY output, if a retry happened. */
  retryCostId?: string;
  reviewId: string;
  businessId: string;
  version: number;
  correlationId: string | undefined;
  suppressNotification: boolean;
  originLane: GenerateResponseOriginLane | null;
  loadedReviewContentHash: string | null;
  moderation: ModerationDecision;
  accountId: string;
  /** Diagnostic pre-LLM tier. Grant authority comes from runtimeState only. */
  preLlmSubscriptionTier: SubscriptionTierValue;
  logger: Pick<WorkerLogger, 'log' | 'warn'>;
}

export type PersistResponseOutcome =
  | { kind: 'persisted'; responseId: string }
  | { kind: 'skipped_stale_content' };

/**
 * The content-freshness gate predicate (ADR 0017). A freshness check, not a
 * provenance proof: a null hash on EITHER side passes — legacy pre-hash
 * reviews must keep generating.
 */
export function hasStaleReviewContent(
  loadedReviewContentHash: string | null,
  currentReviewContentHash: string | null,
): boolean {
  return loadedReviewContentHash !== null
    && currentReviewContentHash !== null
    && loadedReviewContentHash !== currentReviewContentHash;
}

export async function persistResponseAndNotify(sql: postgres.Sql, input: PersistResponseInput): Promise<PersistResponseOutcome> {
  const {
    result, retryCostId, reviewId, businessId, version,
    correlationId, suppressNotification, originLane, loadedReviewContentHash,
    moderation, accountId, preLlmSubscriptionTier, logger,
  } = input;

  const responseId = uuidv7();
  // Moderation describes the FINAL output; when an avoid-facts retry happened,
  // the final text's cost row is the retry's row.
  const moderatedCostId = retryCostId ?? result.apiCostId;

  // Structural auto-approval candidacy, decidable from env + job inputs alone
  // (no DB read). Non-candidates skip the businesses FOR UPDATE below AND
  // loadAutoApprovalRuntimeState: (finding 10) they never re-take the business
  // lock, so the FK share→exclusive upgrade hazard doesn't exist for them;
  // (finding 5) a flag-off deploy never reads migration-074 columns.
  const autoApprovalCandidate = isAutoApprovalCandidate({
    originLane,
    version,
    suppressNotification,
  });

  return sql.begin(async (tx): Promise<PersistResponseOutcome> => {
    const { currentReviewContentHash } = await acquirePersistLocks(tx, {
      reviewId,
      businessId,
      responseId,
      accountId,
      isAutoApprovalCandidate: autoApprovalCandidate,
      logger,
    });

    // Content-freshness gate (ADR 0017): runs before the lane split, covers all
    // lanes. Skip-the-INSERT keeps the (review_id, version) slot free for the
    // colliding fresh job — persisting in ANY status would starve it via the
    // idempotency check. Zero writes on skip.
    if (hasStaleReviewContent(loadedReviewContentHash, currentReviewContentHash)) {
      logger.log('content-freshness gate skipped persist', {
        reason: OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT,
        review_id: reviewId,
        business_id: businessId,
        version,
        origin_lane: originLane,
      });
      return { kind: 'skipped_stale_content' }; // tx commits with zero writes
    }

    await tx`
      INSERT INTO responses (
        id, review_id, business_id, response_text, response_language,
        version, status, approval_method, original_draft_text,
        llm_provider, llm_model, prompt_tokens, completion_tokens
      ) VALUES (
        ${responseId}, ${reviewId}, ${businessId}, ${result.responseText}, ${result.language},
        ${version}, ${RESPONSE_STATUS_PENDING_APPROVAL}, ${null}, ${result.responseText},
        ${result.provider}, ${result.model}, ${result.usage.promptTokens}, ${result.usage.completionTokens}
      )
    `;

    if (result.apiCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${result.apiCostId}
      `;
    }

    if (retryCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${retryCostId}
      `;
    }

    const held = await recordModerationAndHold(tx, {
      responseId,
      moderatedCostId,
      moderation,
      accountId,
      businessId,
      reviewId,
      outputExcerpt: result.responseText.slice(0, 200),
    });

    const activeRun = await recordDraftSpineCheckpoints(tx, {
      reviewId,
      businessId,
      responseId,
      version,
      moderation,
      held,
    });

    const { runtimeState, autoDecision } = await resolveAutoApprovalDecision(tx, {
      isAutoApprovalCandidate: autoApprovalCandidate,
      reviewId,
      businessId,
      accountId,
      responseId,
      version,
      originLane,
      suppressNotification,
      loadedReviewContentHash,
      moderation,
      held,
      preLlmSubscriptionTier,
      logger,
    });

    // The moderation veto precedes the policy gate: a held draft never reaches
    // the gate, so no policy_gate step is recorded for it. On every other path
    // the gate decision is known here — one site covers both branches.
    if (activeRun && !held) {
      await recordStep(tx, {
        runId: activeRun.id,
        stepKey: 'policy_gate',
        detail: { decision: autoDecision.approved ? 'auto_approved' : 'held_for_owner' },
      });
    }

    // The `policy_gate_held` Refusal (#1013). A SEPARATE statement with its OWN
    // guard, deliberately OUTSIDE the block above — it inherits that guard's
    // `!held` arm and NOT its `activeRun` arm. A legacy pre-spine review has no
    // run (`recordDraftSpineCheckpoints` returns null), and inheriting
    // `!activeRun` would silently drop rows from the lane with the highest
    // design capacity — silent in production until `AUTO_APPROVAL_ENABLED` is
    // on, but the one that dominates once it is (#997 resolution 1).
    await recordPolicyGateRefusal(tx, {
      accountId,
      businessId,
      responseId,
      originLane,
      held,
      runtimeState,
      autoDecision,
    });

    if (autoDecision.approved) {
      if (!runtimeState) {
        // Impossible: structurallyBlockedDecision never approves. Fail the tx
        // rather than approve without the state the approval must record.
        throw new Error('auto_approval_state_missing_for_approved_decision');
      }
      await approveAutoPolicyAndSchedule(tx, {
        responseId,
        businessId,
        correlationId,
        responseText: result.responseText,
        version,
        autoDecision,
        runtimeState,
        originLane,
        moderation,
      });
      return { kind: 'persisted', responseId };
    }

    // Backfill suppression (spec §4.6, §6.7) OR a high-severity flag both skip
    // the approval notification.
    if (suppressNotification || held) {
      return { kind: 'persisted', responseId };
    }

    await enqueueSendNotification(tx, {
      responseId,
      businessId,
      correlationId,
    });
    return { kind: 'persisted', responseId };
  });
}

/**
 * Resolves the auto-approval decision for a freshly persisted draft, on the
 * OPEN transaction `tx` after the moderation/hold write. Structural
 * non-candidates get their decision without touching the DB: no runtime-state
 * read (074 columns stay unread on flag-off deploys, finding 5) and no
 * fallback log — logAutoApprovalFallbackIfNeeded's isAutoCandidate narrowing
 * requires the live_ingest_new lane AND a configured policy, and structural
 * blocks either fail the lane check or (flag off / regen / suppressed) are
 * not the runtime-prerequisite story that log exists for (spec §15).
 */
async function resolveAutoApprovalDecision(
  tx: postgres.TransactionSql,
  args: {
    isAutoApprovalCandidate: boolean;
    reviewId: string;
    businessId: string;
    accountId: string;
    responseId: string;
    version: number;
    originLane: GenerateResponseOriginLane | null;
    suppressNotification: boolean;
    loadedReviewContentHash: string | null;
    moderation: ModerationDecision;
    held: boolean;
    preLlmSubscriptionTier: SubscriptionTierValue;
    logger: Pick<WorkerLogger, 'log'>;
  },
): Promise<{ runtimeState: AutoApprovalRuntimeState | null; autoDecision: AutoApprovalDecision }> {
  const {
    isAutoApprovalCandidate, reviewId, businessId, accountId, responseId,
    version, originLane, suppressNotification, loadedReviewContentHash,
    moderation, held, preLlmSubscriptionTier, logger,
  } = args;

  if (!isAutoApprovalCandidate) {
    return {
      runtimeState: null,
      autoDecision: structurallyBlockedDecision({ originLane, version, suppressNotification }),
    };
  }

  // FP: sequential reads on the shared tx after the moderation/hold write in the same sql.begin; runtime-state re-read is ordered against the prior tx writes, not independent.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const runtimeState = await loadAutoApprovalRuntimeState(tx, {
    reviewId,
    businessId,
    accountId,
  });
  if (preLlmSubscriptionTier !== runtimeState.subscriptionTier) {
    logger.log('Subscription tier changed during response generation', {
      account_id: accountId,
      pre_llm_subscription_tier: preLlmSubscriptionTier,
      current_subscription_tier: runtimeState.subscriptionTier,
    });
  }
  const autoDecision = evaluateAutoApprovalCandidate({
    originLane,
    version,
    suppressNotification,
    loadedReviewContentHash,
    currentReviewContentHash: runtimeState.currentReviewContentHash,
    currentStarRating: runtimeState.currentStarRating,
    effectivePolicy: runtimeState.effectivePolicy,
    moderation,
    held,
    subscriptionStatus: runtimeState.subscriptionStatus,
    subscriptionTier: runtimeState.subscriptionTier,
    accountPastDueAt: runtimeState.accountPastDueAt,
    accountFlags: runtimeState.accountFlags,
    activeLocationNow: runtimeState.activeLocationNow,
    activeZernioConnectionNow: runtimeState.activeZernioConnectionNow,
    triageSeverity: runtimeState.triageSeverity,
    triageSource: runtimeState.triageSource,
    autoApprovedTodayCount: runtimeState.autoApprovedTodayCount,
  });

  logAutoApprovalFallbackIfNeeded({
    logger,
    autoDecision,
    runtimeState,
    responseId,
    reviewId,
    businessId,
    version,
    originLane,
    moderation,
  });

  return { runtimeState, autoDecision };
}

/**
 * Lock preamble for the persist transaction. Runs as the transaction's FIRST
 * statements on the OPEN transaction `tx` — it must precede the responses
 * INSERT, so callers may not reorder it after any other tx statement.
 */
async function acquirePersistLocks(
  tx: postgres.TransactionSql,
  args: {
    reviewId: string;
    businessId: string;
    responseId: string;
    accountId: string;
    isAutoApprovalCandidate: boolean;
    logger: Pick<WorkerLogger, 'warn'>;
  },
): Promise<{ currentReviewContentHash: string | null }> {
  const {
    reviewId, businessId, responseId, accountId, isAutoApprovalCandidate, logger,
  } = args;

  // Take the review row lock as the transaction's FIRST statement
  // (run-spine.ts lock-ordering contract). It must precede the responses
  // INSERT below: that INSERT's FK on review_id takes an implicit
  // FOR KEY SHARE on the reviews tuple, and upgrading share → FOR UPDATE
  // later deadlocks against concurrent FOR UPDATE waiters (content-changed
  // ingest, edit-publish/failed-hook, or another persist for the same
  // review). Taking FOR UPDATE first subsumes the later KEY SHARE. Bonus:
  // the auto-approval content-hash re-read further down happens under this
  // lock, so it cannot race a concurrent content-changed ingest. The
  // content-freshness gate's freshness re-read (ADR 0017) rides this SAME
  // statement: the current review_content_hash returned here is read under
  // the lock, so the gate's comparison cannot race a concurrent
  // content-changed ingest either.
  const [reviewLock] = await tx<{ id: string; review_content_hash: string | null }[]>`
    SELECT id, review_content_hash FROM reviews
    WHERE id = ${reviewId} AND business_id = ${businessId}
    FOR UPDATE
  `;
  if (!reviewLock) {
    // Review not visible to its business — impossible if FKs hold (caller
    // bug / corrupt state only). The lock no-oped, so the ordering contract
    // is void for this tx; surface loudly (same posture as mark-posted.ts)
    // but proceed — control flow is unchanged.
    Sentry.captureMessage('orphan_response_review', {
      level: 'warning',
      extra: {
        response_id: responseId,
        review_id: reviewId,
        business_id: businessId,
        site: 'persist',
      },
    });
    logger.warn(
      `Review ${reviewId} not found for business ${businessId} — persist review lock no-oped (response ${responseId})`,
    );
  }

  // CANDIDATES ONLY: take the businesses row FOR UPDATE before the responses
  // INSERT below — the INSERT's business_id FK takes an implicit FOR KEY
  // SHARE on this row, and upgrading share → FOR UPDATE later (the
  // auto-approval cap count) deadlocks against a concurrent persist for the
  // same business. Same subsume-the-KEY-SHARE pattern as the reviews lock
  // above. Also the serialization point for the daily-cap count (spec §2.3).
  // Structural non-candidates skip it: they never run the cap count, so the
  // share→exclusive upgrade this lock pre-empts cannot happen for them
  // (finding 10) — and skipping keeps flag-off persists off the business
  // row's lock queue entirely.
  if (isAutoApprovalCandidate) {
    await tx`
      SELECT id FROM businesses WHERE id = ${businessId} FOR UPDATE
    `;
    // Fixed WS8 approval-lane order: reviews -> businesses -> entitlement,
    // before the responses INSERT (and every later account-FK child write).
    await acquireTierEntitlementLock(tx, accountId);
  }

  return { currentReviewContentHash: reviewLock?.review_content_hash ?? null };
}

/**
 * Run-spine checkpoints for a freshly persisted draft: the draft_generated and
 * moderation_checked steps plus the reply_drafted outcome. Runs on the OPEN
 * transaction `tx` so the checkpoints stay atomic with the response INSERT,
 * mirroring recordModerationAndHold. Returns the active run (null for legacy
 * reviews ingested before the spine existed) so the caller can record the
 * later policy_gate step on the same run.
 */
async function recordDraftSpineCheckpoints(
  tx: postgres.TransactionSql,
  args: {
    reviewId: string;
    businessId: string;
    responseId: string;
    version: number;
    moderation: ModerationDecision;
    held: boolean;
  },
): Promise<{ id: string; account_id: string } | null> {
  const { reviewId, businessId, responseId, version, moderation, held } = args;

  const activeRun = await findActiveReviewRun(tx, reviewId);
  if (activeRun) {
    await recordStep(tx, {
      runId: activeRun.id,
      stepKey: 'draft_generated',
      detail: { response_id: responseId, version },
    });
    await recordStep(tx, {
      runId: activeRun.id,
      stepKey: 'moderation_checked',
      status: held ? 'failed' : 'completed',
      detail: { flagged: moderation.flagged, severity: moderation.severity ?? null, held },
    });
    await recordOutcome(tx, {
      runId: activeRun.id,
      accountId: activeRun.account_id,
      businessId,
      attributedAgent: 'reply',
      outcomeKind: 'reply_drafted',
    });
  }
  return activeRun;
}

/**
 * The auto-approval commit for an approved policy decision: flips the response
 * to approved/auto_policy with the veto-window deadline, writes the durable
 * approval audit row, and enqueues the delayed publish + the pending-post
 * notice. Runs on the OPEN transaction `tx` so the approval stays atomic with
 * the response INSERT (invariant #2/#3), mirroring recordModerationAndHold.
 */
async function approveAutoPolicyAndSchedule(
  tx: postgres.TransactionSql,
  args: {
    responseId: string;
    businessId: string;
    correlationId: string | undefined;
    responseText: string;
    version: number;
    autoDecision: AutoApprovalDecision;
    runtimeState: AutoApprovalRuntimeState;
    originLane: GenerateResponseOriginLane | null;
    moderation: ModerationDecision;
  },
): Promise<void> {
  const {
    responseId, businessId, correlationId, responseText, version,
    autoDecision, runtimeState, originLane, moderation,
  } = args;
  const vetoWindowMinutes = runtimeState.effectivePolicy.vetoWindowMinutes;

  // FP: ordered writes inside one sql.begin tx (approve UPDATE → audit log → enqueue publish + notice); parallelizing would break tx ordering.
  // react-doctor-disable-next-line react-doctor/async-parallel
  const [scheduled] = await tx<{ auto_post_scheduled_at: Date }[]>`
    UPDATE responses
    SET status = ${RESPONSE_STATUS_APPROVED},
        approval_method = ${APPROVAL_METHOD.AUTO_POLICY},
        approved_text = ${responseText},
        approved_at = NOW(),
        auto_post_scheduled_at = NOW() + make_interval(mins => ${vetoWindowMinutes}),
        posting_error = NULL,
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status = ${RESPONSE_STATUS_PENDING_APPROVAL}
    RETURNING auto_post_scheduled_at
  `;
  if (!scheduled) {
    // Guarded UPDATE lost a race — roll the tx back; generation-job retry semantics cover it.
    throw new Error('auto_approve_transition_lost');
  }

  await insertAuditLogAutoPolicy(tx, {
    responseId,
    businessId,
    responseTextAtApproval: responseText,
    metadata: {
      ...buildAutoApprovalDecisionSummary({ autoDecision, runtimeState, originLane, moderation, version }),
      policy_id: runtimeState.effectivePolicy.policyId,
      star_rating: runtimeState.currentStarRating,
      veto_window_minutes: vetoWindowMinutes,
      correlation_id: correlationId,
    },
  });

  // availableAt is the DB-clock-derived deadline the UPDATE just stamped,
  // so the outbox delay window and the owner-visible deadline agree —
  // postgres.js Dates carry ms precision, so this bind can differ from
  // the stored timestamptz; the difference is sub-ms, absorbed by the
  // poller cadence.
  await enqueuePublishResponse(tx, {
    responseId,
    businessId,
    correlationId,
    availableAt: scheduled.auto_post_scheduled_at,
  });
  await enqueuePendingPostNotice(tx, { responseId, businessId, correlationId });
}

function logAutoApprovalFallbackIfNeeded(input: {
  logger: Pick<WorkerLogger, 'log'>;
  autoDecision: AutoApprovalDecision;
  runtimeState: AutoApprovalRuntimeState;
  responseId: string;
  reviewId: string;
  businessId: string;
  version: number;
  originLane: GenerateResponseOriginLane | null;
  moderation: ModerationDecision;
}): void {
  const {
    logger,
    autoDecision,
    runtimeState,
    responseId,
    reviewId,
    businessId,
    version,
    originLane,
    moderation,
  } = input;
  if (autoDecision.approved || autoDecision.blockReasons.length === 0) {
    return;
  }

  if (!isGenuineAutoCandidate(originLane, runtimeState)) {
    return;
  }

  logger.log('Auto-approval fallback to owner review', {
    ...buildAutoApprovalDecisionSummary({ autoDecision, runtimeState, originLane, moderation, version }),
    response_id: responseId,
    review_id: reviewId,
    business_id: businessId,
    block_reasons: autoDecision.blockReasons,
  });
}

/**
 * Compile-time drift tripwire for the decision summary: every key it emits
 * must exist on AutoPolicyAuditMetadata (src/lib/approval/audit.ts), whose
 * deny-by-default compactor only persists allowlisted keys. Annotating the
 * summary as a Pick of that interface means a future summary key that skips
 * the interface + AUTO_POLICY_METADATA_KEYS fails to compile here instead of
 * being silently dropped from the durable approval_audit_log row.
 */
type AutoApprovalDecisionSummary = Pick<
  AutoPolicyAuditMetadata,
  | 'policy_source'
  | 'resolved_min_star'
  | 'origin_lane'
  | 'response_version'
  | 'provider_status'
  | 'review_content_hash_matched'
  | 'publisher_subscription_allowed'
  | 'publisher_subscription_reason'
  | 'active_zernio_connection'
  | 'active_location'
  | 'triage_severity'
  | 'triage_source'
  | 'daily_cap'
  | 'auto_approved_today'
  | 'policy_suspended'
  | 'runtime_enabled'
  | 'provider_moderation_enabled'
>;

/**
 * The resolved auto-approval decision facts shared by the durable approval
 * audit row and the sanitized fallback log — one owner so the two sinks can
 * never drift. Carries no review/response text or raw hashes, so it is safe to
 * spread into both the audit metadata and the structured log (spec §11, §15).
 */
function buildAutoApprovalDecisionSummary(input: {
  autoDecision: AutoApprovalDecision;
  runtimeState: AutoApprovalRuntimeState;
  originLane: GenerateResponseOriginLane | null;
  moderation: ModerationDecision;
  version: number;
}): AutoApprovalDecisionSummary {
  const { autoDecision, runtimeState, originLane, moderation, version } = input;
  return {
    policy_source: runtimeState.effectivePolicy.source,
    resolved_min_star: runtimeState.effectivePolicy.threshold,
    origin_lane: originLane,
    response_version: version,
    provider_status: moderation.providerStatus,
    review_content_hash_matched: autoDecision.reviewContentHashMatched,
    publisher_subscription_allowed: autoDecision.publisherSubscription.allowed,
    publisher_subscription_reason: autoDecision.publisherSubscription.allowed
      ? null
      : autoDecision.publisherSubscription.reason,
    active_zernio_connection: runtimeState.activeZernioConnectionNow,
    active_location: runtimeState.activeLocationNow,
    triage_severity: runtimeState.triageSeverity,
    triage_source: runtimeState.triageSource,
    daily_cap: resolveDailyCap(runtimeState.effectivePolicy),
    auto_approved_today: runtimeState.autoApprovedTodayCount,
    policy_suspended: runtimeState.effectivePolicy.suspended,
    runtime_enabled: autoDecision.runtimeEnabled,
    provider_moderation_enabled: autoDecision.providerModerationEnabled,
  };
}

/**
 * A GENUINE auto candidate: a draft on the auto-eligible lane whose account has
 * a policy configured, so the only thing standing between it and an auto-post is
 * a runtime prerequisite (provider moderation, subscription, active
 * connection/location, review-hash freshness, or the runtime flag). Bad-lane and
 * no-policy drafts were never going to auto (spec §15).
 *
 * ONE OWNER FOR THE NARROWING, and that is the point rather than a tidy-up. The
 * fallback LOG and the `policy_gate_held` ledger write must select exactly the
 * same drafts: the intake's reconciliation query asserts that the row count can
 * never exceed the log-line count, and two copies of these three conditions
 * would let that drift silently. #998 says the ledger write inherits the
 * narrowing "unchanged" — this is what makes that literally true.
 *
 * A TYPE PREDICATE, so the ledger site gets its non-null `runtimeState` for free
 * rather than re-asserting it.
 *
 * THIS IS ALSO WHERE THE FLAG-OFF ANSWER LIVES (deviation D4). With
 * `AUTO_APPROVAL_ENABLED` off, every draft is a STRUCTURAL non-candidate,
 * `resolveAutoApprovalDecision` returns `runtimeState: null` and reads no policy
 * row at all — so this returns false and no Refusal is written. #1013's "Volume"
 * section and #1003's operational note both claim a row on that path; both are
 * false against this code, because "on a policy-configured account" is not
 * knowable without a read migration 074's header deliberately avoids.
 */
function isGenuineAutoCandidate(
  originLane: GenerateResponseOriginLane | null,
  runtimeState: AutoApprovalRuntimeState | null,
): runtimeState is AutoApprovalRuntimeState {
  return runtimeState !== null
    && originLane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW
    && runtimeState.effectivePolicy.threshold !== null;
}

/**
 * Records the `policy_gate_held` **Refusal** for a draft the auto-approval gate
 * held for the owner. Runs on the OPEN transaction `tx`, so the row is atomic
 * with the decision it records (#1013).
 *
 * FOUR GUARDS, AND ONLY THE LAST ONE DECIDES ANYTHING. Branch review round 1
 * mutation-tested each: deleting guards 1, 2 or 3 individually changes no
 * outcome and kills no test, because guard 4 already covers each case. They are
 * EARLY RETURNS and defence in depth, not independent conditions — an earlier
 * version of this docblock claimed "each answers a different question", which
 * was false and is corrected here rather than left to mislead the next reader.
 *
 *   1. `held` — a high-severity flag belongs to the `held_draft` lane. #998's
 *      suppression rule, and the ONLY condition inherited from the `policy_gate`
 *      step's guard. REDUNDANT WITH THE VETO: `evaluateAutoApprovalCandidate`
 *      always emits `moderation_held` when `held` is true, and that member maps
 *      to `null`, so guard 4 suppresses the row anyway. Kept because it names
 *      the rule at the site a reader looks for it, and because it skips work.
 *   2. `approved` — nothing was refused. Redundant: `approved` means
 *      `blockReasons` is empty, and the resolver returns `null` for an empty
 *      set.
 *   3. the candidacy narrowing — see `isGenuineAutoCandidate`. Its `originLane`
 *      and `threshold` arms are BOTH redundant *here*: a wrong lane is a
 *      structural block (so `runtimeState` is null and the predicate fails on
 *      its first arm), and a null threshold emits `policy_not_enabled`, itself a
 *      veto member. The arm that is NOT redundant is `runtimeState !== null`.
 *      The narrowing earns its keep on the LOG side, which has no veto concept —
 *      which is why one predicate owns both, and why the threshold arm's only
 *      oracle is the fallback-log assertion in the integration suite.
 *   4. the resolver returned nothing — the set was empty, or a `null`-mapped
 *      member vetoed it. THIS is the load-bearing guard.
 *
 * NOT CAUGHT AT THE CALL SITE, on the same terms as the `held_draft` write and
 * `write.ts`'s own contract: a CHECK violation is a writer bug and must abort
 * this transaction. What `withLedgerAttribution` adds is ATTRIBUTION, not
 * recovery — see its docblock.
 */
async function recordPolicyGateRefusal(
  tx: postgres.TransactionSql,
  args: {
    accountId: string;
    businessId: string;
    responseId: string;
    originLane: GenerateResponseOriginLane | null;
    held: boolean;
    runtimeState: AutoApprovalRuntimeState | null;
    autoDecision: AutoApprovalDecision;
  },
): Promise<void> {
  const { accountId, businessId, responseId, originLane, held, runtimeState, autoDecision } = args;

  if (held) return;
  if (autoDecision.approved) return;
  if (!isGenuineAutoCandidate(originLane, runtimeState)) return;

  const refusal = resolvePolicyGateRefusal(autoDecision.blockReasons);
  if (!refusal) return;

  await withLedgerAttribution('policy_gate_held', responseId, () => writeRefusalEvent(tx, {
    accountId,
    businessId,
    refusalSource: 'policy_gate_held',
    refusalCode: refusal.refusalCode,
    allRefusalCodes: refusal.allRefusalCodes,
    refusalCategory: refusal.refusalCategory,
    subjectType: 'response',
    subjectId: responseId,
    // This lane has NO immutable stamp of its own (#997 F5) — which is exactly
    // why `occurred_at` is writer-supplied. The gate decided inside this
    // transaction, so its transaction timestamp IS the decision time.
    occurredAt: 'transaction_time',
  }));
}

/**
 * Attribute a ledger failure to the Refusal ledger, then RETHROW unchanged.
 *
 * WHY THIS EXISTS, and it is not observability for its own sake. Both write
 * sites are deliberately uncaught: a migration-116 CHECK violation is a writer
 * bug and must abort the response persist (`write.ts`'s contract). The stated
 * lever against such a bug is the `REFUSAL_LEDGER_ENABLED` kill switch — but
 * branch review round 1 (adversarial axis) showed an operator could not FIND
 * that lever. A deterministic violation aborts every persist,
 * `generate_response` burns its attempts in about 75 seconds, and the only
 * signal is `attachJobFailureSink`'s generic `subsystem=worker_job` issue on the
 * terminal attempt. Nothing said "the ledger did this" or "flip its flag".
 *
 * IT CHANGES NO CONTROL FLOW. The error is re-thrown, so the transaction still
 * aborts and no response commits without its required row. This is NOT the
 * "best-effort work needs its own try/catch" rule from `.claude/CLAUDE.md` —
 * that rule is about work AFTER a primary side effect, and swallowing here would
 * commit a draft whose Refusal was never recorded.
 *
 * The capture is itself guarded: a failing reporter must never replace the real
 * error with a reporting error.
 */
async function withLedgerAttribution<T>(
  lane: 'held_draft' | 'policy_gate_held',
  responseId: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    try {
      Sentry.captureException(error, {
        level: 'error',
        tags: { subsystem: 'refusal_ledger', refusal_lane: lane, flag: REFUSAL_LEDGER_FLAG },
        extra: { response_id: responseId },
      });
    } catch {
      // A broken reporter must not mask the writer bug it was reporting.
    }
    throw error;
  }
}

/**
 * Records moderation metadata on the final output's api_costs row and, for a
 * high-severity flag, HOLDS the draft by writing a flagged_responses row AND its
 * `held_draft` **Refusal** (#1013). Runs on the OPEN transaction `tx` so all
 * three stay atomic with the response INSERT (invariant #4). Returns whether the
 * draft was held (high-severity), which the caller uses to skip the
 * send_notification enqueue.
 */
async function recordModerationAndHold(
  tx: postgres.TransactionSql,
  args: {
    responseId: string;
    moderatedCostId: string | null;
    moderation: ModerationDecision;
    accountId: string;
    businessId: string;
    reviewId: string;
    outputExcerpt: string;
  },
): Promise<boolean> {
  const { responseId, moderatedCostId, moderation, accountId, businessId, reviewId, outputExcerpt } = args;
  const flaggedHigh = moderation.flagged && moderation.severity === 'high';

  // Record moderation metadata on the cost row for the final output. Excerpt
  // is for operational triage only — full text already lives on responses.
  if (moderatedCostId) {
    await tx`
      UPDATE api_costs SET
        moderation_score = ${moderation.score},
        moderation_categories = ${tx.json(moderation.categories as never)},
        flagged = ${moderation.flagged},
        flag_reason = ${moderation.reason},
        output_excerpt = ${outputExcerpt}
      WHERE id = ${moderatedCostId}
    `;
  }

  // High-confidence unsafe draft: hold it for admin disposition (PR 3b) and
  // do NOT enqueue the owner notification. The response stays pending_approval.
  if (flaggedHigh) {
    // `flagged_responses` is outside `scripts/ci/tenant-tables.ts` →
    // unaudited by `ci:tenant-scope`; tenant ids come from the response row
    // this same transaction just persisted.
    await tx`
      INSERT INTO flagged_responses (
        id, response_id, account_id, business_id, review_id, api_cost_id,
        source, reason, severity, status
      ) VALUES (
        ${uuidv7()}, ${responseId}, ${accountId}, ${businessId}, ${reviewId}, ${moderatedCostId ?? null},
        ${moderation.source ?? 'local_regex'}, ${moderation.reason}, ${moderation.severity}, ${FLAGGED_RESPONSE_STATUS_OPEN}
      )
    `;

    // The `held_draft` Refusal, on the SAME transaction as the hold it records
    // (#1013). Not caught: migration 116's CHECKs each name a writer bug, and a
    // violation aborting this transaction is the designed behaviour — the lever
    // against a writer bug is REFUSAL_LEDGER_ENABLED, not a try/catch here.
    //
    // `occurredAt` is the transaction-time sentinel because
    // `flagged_responses.created_at` above is `DEFAULT NOW()` in this same
    // transaction, and in Postgres `NOW()` is `transaction_timestamp()` — so the
    // two agree to the microsecond. Reading that column back and passing a JS
    // `Date` would truncate the microseconds on decode (#520) and lose exactly
    // the equality that makes the two rows joinable.
    //
    // No candidacy narrowing and no `activeRun` condition: a high-severity flag
    // is a moderation decision on every lane, and it is recorded wherever it
    // happens.
    await withLedgerAttribution('held_draft', responseId, () => writeRefusalEvent(tx, {
      accountId,
      businessId,
      refusalSource: 'held_draft',
      refusalCode: null,
      allRefusalCodes: null,
      refusalCategory: HELD_DRAFT_REFUSAL_CATEGORY,
      subjectType: 'response',
      subjectId: responseId,
      occurredAt: 'transaction_time',
    }));
  }

  return flaggedHigh;
}
