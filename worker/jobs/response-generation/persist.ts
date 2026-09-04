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
  type AutoApprovalBlockReason,
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
  POLICY_GATE_HELD_REFUSAL_CATEGORIES,
  resolvePolicyGateRefusal,
} from '../../../src/lib/refusals/vocabulary';
import {
  REFUSAL_LEDGER_FLAG,
  isRefusalLedgerEnabled,
  noteRefusalLedgerDark,
  noteUnmappedBlockReasons,
  writeRefusalEvent,
} from '../../../src/lib/refusals/write';
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
 * Would this block-reason set have produced a Refusal row?
 *
 * GUARD 4'S WARNING PREDICATE, AND NOTHING ELSE. It exists so the kill switch can
 * still report a real ledger gap without running `resolvePolicyGateRefusal` —
 * the throwing code the switch is there to contain (#1079). It answers the same
 * question the resolver answers, for the subset of inputs where the answer is
 * decidable without throwing, which is every input that matters here.
 *
 * IT CANNOT THROW, and that is the property that keeps it inside the containment
 * guarantee. `Object.hasOwn` is the resolver's own membership test
 * (`vocabulary.ts`), and an unmapped member returns `false` here where the
 * resolver would throw — correct, because an unmapped member records no row
 * either way, so there is no gap to warn about.
 *
 * `every`, NEVER `some`. A single `null`-mapped member vetoes the whole row
 * whatever its position (#1003), so `some(mapped && non-null)` returns true for
 * a set that resolves to nothing — and warning there is exactly the noise
 * `writeRefusalEvents`' contract forbids. The review that found the missing
 * warning proposed `some`; this is the corrected form.
 *
 * BE PRECISE ABOUT WHERE `some` BREAKS, because the loose version of that
 * sentence shipped on this branch and named the wrong set. `some` does NOT
 * over-warn on a veto-ONLY set — it is false there too, because the only member
 * maps to `null`. It over-warns on a MIXED set: one mapped non-null member plus
 * one `null`-mapped member. Red team's shrunk counterexample is
 * `["policy_not_enabled","current_rating_missing"]`, and the live-DB half-B case
 * refuted `some` a second time on the copilot/2-star fixture. So the `!== null`
 * test INSIDE the callback is what saves the veto-only case — NOT the length
 * check.
 *
 * THE LENGTH CHECK IS LOAD-BEARING HERE AND UNREACHABLE AT THE CALL SITE, and
 * both halves are true at once. Read in isolation this function needs it:
 * `every` is vacuously true on `[]`, so without the conjunct an empty set would
 * report a gap. At its ONLY call site it can never be false — guard 2
 * (`if (autoDecision.approved) return;`) runs first, and across BOTH
 * `AutoApprovalDecision` construction sites in `./auto-approval`
 * `approved === true` ⟺ `blockReasons` is empty
 * (`evaluateAutoApprovalCandidate` sets `approved: blockReasons.length === 0`,
 * and `structurallyBlockedDecision` throws rather than returning a
 * structurally-blocked decision with an empty set). Red team measured the
 * consequence: dropping the conjunct SURVIVES the whole touched surface, 99/99.
 * That mutant is PROVEN-EQUIVALENT, not an untested gap — keep the conjunct as
 * defence in depth against a future guard reorder, and do not read its survival
 * as missing coverage.
 */
function wouldRecordRefusal(blockReasons: readonly AutoApprovalBlockReason[]): boolean {
  return blockReasons.length > 0
    && blockReasons.every(
      (code) => Object.hasOwn(POLICY_GATE_HELD_REFUSAL_CATEGORIES, code)
        && POLICY_GATE_HELD_REFUSAL_CATEGORIES[code] !== null,
    );
}

/**
 * The members the category map does not hold, in INPUT ORDER (#1105).
 *
 * GUARD 4'S OTHER WARNING PREDICATE, and it sits here beside
 * `wouldRecordRefusal` for the same reason that one does: guard 4 contains a
 * vocabulary fault by NON-EXECUTION, so every predicate it consults must be
 * decidable without running `resolvePolicyGateRefusal`. `Object.hasOwn` is the
 * resolver's own membership test and CANNOT THROW, which is what keeps this
 * inside the containment guarantee.
 *
 * `some`-SHAPED, WHERE `wouldRecordRefusal` IS `every`-SHAPED, and the asymmetry
 * is correct rather than an oversight. A ledger GAP is a property of the WHOLE
 * decision — one `null`-mapped member vetoes the entire row (#1003), so every
 * member must record for a gap to exist. A vocabulary hole is a property of a
 * SINGLE CODE: one unmapped member is one defect in the map, whatever its
 * neighbours do. Reading the two predicates as variants of each other is how a
 * later edit collapses them.
 *
 * THE TWO ARE MUTUALLY EXCLUSIVE, AND THAT FALLS OUT OF THESE DEFINITIONS
 * rather than out of the call site's control flow: a non-empty result here makes
 * `wouldRecordRefusal`'s `Object.hasOwn` conjunct false, so the two `if`s below
 * can never both fire. Guard 4 states that and a case asserts it, which is what
 * lets the `else` stay deleted.
 *
 * IT LIVES HERE AND NOT IN `write.ts`, and the eval is why. The first draft put
 * the membership test inside `noteUnmappedBlockReasons`, so the call site handed
 * over every decision and let the helper decide. `persist.test.ts` mocks that
 * module, so its spy recorded a call for a HEALTHY set too and four of its five
 * cases asserted a count that discriminates nothing. With the test here, the
 * lane's own suite observes the lane's own decision.
 *
 * A NON-EMPTY RESULT NEEDS A VALUE THAT ESCAPED THE UNION — AND CREDIT THE
 * RIGHT GUARD FOR THAT. A member with no map entry is caught by the map's own
 * `satisfies Record<AutoApprovalBlockReason, RefusalCategory | null>` clause
 * (`vocabulary.ts`), which fails `pnpm typecheck` as a TS1360.
 * `_PrecedenceIsTotal` is a DIFFERENT assertion: it catches a member that is
 * mapped but left out of `AUTO_APPROVAL_BLOCK_PRECEDENCE`, and it fires on a map
 * hole only as fallout — `vocabulary.ts` says so at the assertion itself. An
 * earlier version of this docblock credited `_PrecedenceIsTotal` with both, and
 * disagreed with this file's own test comment inside one diff.
 *
 * So this predicate is defence in depth against a RUN-TIME escapee, not a live
 * fault. That is the whole of #1105 and the ticket says so itself.
 *
 * THE FAULT CLASS IS NOT CLOSED CODEBASE-WIDE, only this shape of it. Five lanes
 * index a category map directly (`MAP[reason]`) instead of resolving through
 * `resolvePolicyGateRefusal`; there an unmapped member yields `undefined` rather
 * than a throw, and with the ledger off they raise the ledger-dark warning —
 * claiming a gap for a row migration 116's NOT NULL would reject, and naming no
 * code. Different mechanism, different fix, deliberately a different ticket.
 * Recorded because red team's sibling sweep found leaving it unrecorded to be
 * the actual omission.
 */
function unmappedBlockReasons(
  blockReasons: readonly AutoApprovalBlockReason[],
): readonly AutoApprovalBlockReason[] {
  return blockReasons.filter((code) => !Object.hasOwn(POLICY_GATE_HELD_REFUSAL_CATEGORIES, code));
}

/**
 * Records the `policy_gate_held` **Refusal** for a draft the auto-approval gate
 * held for the owner. Runs on the OPEN transaction `tx`, so the row is atomic
 * with the decision it records (#1013).
 *
 * (`wouldRecordRefusal` sits above this docblock — it is guard 4's warning
 * predicate, and its contract is stated there.)
 *
 * FIVE GUARDS, AND TWO OF THEM DECIDE SOMETHING — guard 4, which decides
 * whether the ledger RUNS AT ALL, and guard 5, which decides whether this
 * decision is recordable.
 *
 * WHICH GUARDS ARE SAFE TO DELETE — RE-MEASURED AT #1079, ONE AT A TIME, AND THE
 * ANSWER CHANGED. Branch review round 1 recorded "deleting guard 1, 2 or 3
 * individually changes no outcome and kills no test". #1079's red-team passes
 * re-ran that experiment and found it true for exactly one of the three. The
 * VERDICTS below are the measurement — do not re-derive them from reading the
 * code. A SURVIVOR COUNT, unlike a verdict, is a property of the test surface it
 * was taken against and goes stale the moment a case is added, so each count
 * below names its surface: re-measure it or drop it, never edit it to fit.
 *
 *   - GUARD 1 — deletion KILLS a test. `refusal-write.integration.test.ts`'s
 *     held_draft pin asserts the resolver spy stays at zero, and guard 1 is what
 *     keeps it there: with `held` true the gate emits `moderation_held`, so
 *     `approved` is false and guards 2-4 all pass. The recorded call is
 *     `["moderation_flagged","moderation_held"]`. THE COMMIT THAT RE-ASSERTED THE
 *     OLD CLAIM IS THE COMMIT THAT FALSIFIED IT — that pin did not exist when
 *     round 1 measured.
 *   - GUARD 2 — deletion SURVIVES. The old claim holds here, and only here.
 *     Re-measured at red-team round 2 against the two suites that cover this
 *     function — `persist.test.ts` + `refusal-write.integration.test.ts`, 85
 *     cases at that point — where it survived 85/85. (Round 1 published 82/82
 *     against the 82-case version of the same two suites; this branch then added
 *     three cases, which is what moved the number and not the verdict.)
 *   - GUARD 3 — deletion KILLS a pre-existing test AND CHANGES THE OUTCOME: a
 *     `policy_gate_held` row is written for a structural non-candidate
 *     ("expected length +0 but got 1"). This was already false at the fork point;
 *     round 1 simply never measured it. Deleting guard 3 is a ledger
 *     data-correctness defect, not a tidy-up.
 *
 * Guards 1-3 are EARLY RETURNS and defence in depth, not independent conditions —
 * an earlier version of this docblock claimed "each answers a different
 * question", which was false and is corrected here rather than left to mislead
 * the next reader. "Defence in depth" is not "free to remove".
 *
 *   1. `held` — a high-severity flag belongs to the `held_draft` lane. #998's
 *      suppression rule, and the ONLY condition inherited from the `policy_gate`
 *      step's guard. REDUNDANT WITH THE VETO: `evaluateAutoApprovalCandidate`
 *      always emits `moderation_held` when `held` is true, and that member maps
 *      to `null`, so guard 5 suppresses the row anyway. Kept because it names
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
 *   4. `isRefusalLedgerEnabled()` — THE KILL SWITCH, AND IT IS NOT REDUNDANT
 *      WITH ANY OTHER GUARD. It covers what guard 5 cannot: `write.ts` read the
 *      switch AFTER this function had already resolved a category, so a
 *      `resolvePolicyGateRefusal` throw — an unmapped or unranked block reason —
 *      aborted the whole response persist with the switch already OFF, and
 *      `generate_response` burned its attempts against a lever an operator had
 *      already pulled (#1079). Containment here is by NON-EXECUTION: nothing
 *      below this line runs.
 *
 *      IT RAISES TWO DIFFERENT SIGNALS, AND CONFLATING THEM IS THE BUG #1105
 *      FIXED. `noteUnmappedBlockReasons` reports that a block reason has no
 *      category MAPPING; `noteRefusalLedgerDark` reports that a Refusal row
 *      would have been WRITTEN and was not. Different faults, different
 *      messages, different Sentry levels (`error` against `warning`), different
 *      latches with different lifetimes — the vocabulary latch is per PROCESS,
 *      because a map hole does not end when an operator flips the flag back.
 *      Before #1105 only the second existed, so an unmapped code produced
 *      nothing at all here and an operator could not tell a pulled lever from a
 *      broken map behind one.
 *
 *      THEY ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION, WHICH IS WHY THE ARM HAS NO
 *      `else`. An unmapped member is exactly what makes `wouldRecordRefusal`'s
 *      `Object.hasOwn` conjunct false, so the two `if`s can never both fire. The
 *      exclusivity belongs to the predicates; an `else` would move it into the
 *      control flow, where a later edit that broke it would go unnoticed instead
 *      of failing the case that asserts it.
 *
 *      THE LEDGER-DARK WARNING STILL FIRES ONLY WHEN A ROW WOULD GENUINELY HAVE
 *      BEEN WRITTEN.
 *      The rule is `writeRefusalEvents`' contract in `src/lib/refusals/write.ts`
 *      (bullet 1, cited BY SYMBOL — a line range here went stale inside its own
 *      commit): a decision that records nothing either way has no ledger GAP,
 *      and warning about it would put noise on the one signal that says the
 *      ledger is dark. An earlier draft of this branch concluded the guard could
 *      not know that without running the resolver it exists to avoid, and gave
 *      the warning up. Branch review round 1 (async axis) showed that premise is
 *      FALSE: map membership is decidable with `Object.hasOwn`, which cannot
 *      throw, so `wouldRecordRefusal` below settles it inside the containment
 *      guarantee and `noteRefusalLedgerDark` raises the same once-per-episode
 *      line the write arms raise.
 *
 *      THE PREDICATE IS `every`, NEVER `some`, and the difference is the whole
 *      correctness of this arm. One `null`-mapped member vetoes the entire row
 *      (#1003), so `some(mapped && non-null)` would warn about a decision that
 *      was never going to be recorded — re-breaking the exact rule this arm
 *      exists to respect. The review that found the gap proposed `some`; it is
 *      wrong for that reason. AND THE REASON IS NARROWER THAN THE OBVIOUS ONE:
 *      `some` does not over-warn on a veto-ONLY set (it is false there too — the
 *      only member maps to `null`); it over-warns on a MIXED set, one mapped
 *      non-null member plus one `null`-mapped one. Red team shrank it to
 *      `["policy_not_enabled","current_rating_missing"]`. `wouldRecordRefusal`'s
 *      docblock carries the full statement and the measurement; do not restate
 *      it loosely here.
 *
 *      A SECOND, LIVE READ still happens inside `writeRefusalEvent`. THE WINDOW
 *      BETWEEN THEM IS ZERO, not "microseconds": no `await` separates them —
 *      `withLedgerAttribution` is wholly synchronous (#1083) and
 *      `writeRefusalEvent` runs synchronously to its first `await`, and the
 *      second read is that function's first statement. A mid-process flip cannot
 *      land between them, so there is nothing here to defend against and nothing
 *      for a test to exercise.
 *   5. the resolver returned nothing — the set was empty, or a `null`-mapped
 *      member vetoed it. THIS is the guard that decides whether a Refusal is
 *      recordable. It sits on the wrapper's RETURN VALUE, immediately after it:
 *      the resolve it depends on is attributed, and the write it gates is not
 *      wrapped, because the writer attributes that one itself (#1083).
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
  // Guard 4 — the kill switch, BEFORE the resolve. Nothing below this line runs.
  // Two signals, two independent `if`s and no `else`: they are mutually
  // exclusive by CONSTRUCTION, and the docblock above states why. Neither call
  // may throw.
  if (!isRefusalLedgerEnabled()) {
    const unmapped = unmappedBlockReasons(autoDecision.blockReasons);
    if (unmapped.length > 0) noteUnmappedBlockReasons(unmapped);
    if (wouldRecordRefusal(autoDecision.blockReasons)) noteRefusalLedgerDark();
    return;
  }

  // The RESOLVE is inside the wrapper, and it is now the ONLY thing inside it. A
  // vocabulary fault is a ledger fault and must report as one; outside, it
  // escaped attribution and surfaced as a generic persist failure (#1079).
  const refusal = withLedgerAttribution(responseId, () =>
    resolvePolicyGateRefusal(autoDecision.blockReasons),
  );
  if (!refusal) return;

  // The WRITE is outside the wrapper (#1083): `writeRefusalEvent` attributes its
  // own faults, so wrapping it here would raise a second Sentry event for one
  // failure.
  await writeRefusalEvent(tx, {
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
  });
}

/**
 * Attribute a Refusal-ledger VOCABULARY failure, then RETHROW unchanged.
 *
 * WHY THIS EXISTS, and it is not observability for its own sake. A ledger fault
 * aborts the response persist by design — a migration-116 CHECK violation is a
 * writer bug (`write.ts`'s contract) and a vocabulary hole is a map bug, and
 * neither may commit a draft whose Refusal was never recorded. The stated lever
 * against either is the `REFUSAL_LEDGER_ENABLED` kill switch — but branch review
 * round 1 (adversarial axis) showed an operator could not FIND that lever. A
 * deterministic fault aborts every persist, `generate_response` burns its
 * attempts in about 75 seconds, and the only signal is `attachJobFailureSink`'s
 * generic `subsystem=worker_job` issue on the terminal attempt. Nothing said
 * "the ledger did this" or "flip its flag".
 *
 * IT COVERS ONE FAULT CLASS, AND IT IS THE ONE THE WRITER CANNOT SEE (#1083).
 * The WRITE fault moved to `writeRefusalEvent`, which owns the statement and
 * calls `captureLedgerWriteFault` on every lane by construction — so a wrapper
 * around a write is now a SECOND Sentry event for one failure, and the
 * `held_draft` invocation, which wrapped a write and nothing else, is gone. What
 * survives is the VOCABULARY RESOLVE (#1079) — an unmapped or unranked block
 * reason throwing out of `resolvePolicyGateRefusal`, which runs BEFORE the
 * writer is ever reached. That is neither a CHECK violation nor a writer bug,
 * the writer can never observe it, and unlike a writer bug it is genuinely
 * SUPPRESSED by the flag now that guard 4 returns before the resolve. So the
 * Sentry issue this wrapper raises is the record of that fault only for a flag
 * flipped IN RESPONSE to it.
 *
 * THE TWO REPORTERS ARE DISJOINT BY POSITION, so this is not redundant with
 * `captureLedgerWriteFault` and the two can never both fire for one failure:
 * this wrapper covers only the resolve, the writer only its own INSERT, and no
 * throw is inside both. Sentry tells them apart by the `fault` TAG —
 * `ledger_vocabulary` here, `ledger_write` there — which is a facet an alert rule
 * can filter on; `extra` differs too (`response_id` here, the writer's four
 * closed fields there) but `extra` is not filterable, and on `policy_gate_held`
 * it was for one round the ONLY thing separating the two. The lane's one-capture
 * cases assert the distinction instead of a bare count.
 *
 * THE GAP THAT USED TO FOLLOW FROM THAT IS CLOSED (#1105), and the sentence
 * describing it is corrected here rather than left standing. It read: "a fault
 * arriving into an already-off flag never runs the resolver and raises nothing,
 * and an operator who resolves the issue once the aborts stop removes the record
 * while the hole stays open." The first half is still true and is the whole
 * point of guard 4. The second half no longer holds: guard 4's off-arm now
 * raises `noteUnmappedBlockReasons` on its own transport, at its own level, with
 * a PROCESS-lifetime latch that does not re-arm when the flag flips back. So the
 * hole is signalled whether the fault arrives before or after the flag moved,
 * and this wrapper is no longer the only record of it.
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
function withLedgerAttribution<T>(responseId: string, resolve: () => T): T {
  try {
    return resolve();
  } catch (error) {
    try {
      Sentry.captureException(error, {
        level: 'error',
        // THE LANE IS A LITERAL, not a parameter. This wrapper covers exactly one
        // resolve on exactly one lane; a `lane` parameter whose type admitted a
        // single value, passed as that same constant from the only call site,
        // said "this generalises" and nothing else.
        tags: {
          subsystem: 'refusal_ledger',
          refusal_lane: 'policy_gate_held',
          fault: 'ledger_vocabulary',
          flag: REFUSAL_LEDGER_FLAG,
        },
        extra: { response_id: responseId },
      });
    } catch {
      // A broken reporter must not mask the map hole it was reporting.
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
    await writeRefusalEvent(tx, {
      accountId,
      businessId,
      refusalSource: 'held_draft',
      refusalCode: null,
      allRefusalCodes: null,
      refusalCategory: HELD_DRAFT_REFUSAL_CATEGORY,
      subjectType: 'response',
      subjectId: responseId,
      occurredAt: 'transaction_time',
    });
  }

  return flaggedHigh;
}
