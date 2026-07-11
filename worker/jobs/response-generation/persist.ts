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
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import { autoApprovalRuntimeEnabled } from '../../../src/lib/auto-approval/flags';
import {
  type AutoApprovalDecision,
  type AutoApprovalRuntimeState,
  evaluateAutoApprovalCandidate,
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
  logger: Pick<WorkerLogger, 'log' | 'warn'>;
}

export async function persistResponseAndNotify(sql: postgres.Sql, input: PersistResponseInput): Promise<string> {
  const {
    result, retryCostId, reviewId, businessId, version,
    correlationId, suppressNotification, originLane, loadedReviewContentHash,
    moderation, accountId, logger,
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
  const isAutoApprovalCandidate =
    autoApprovalRuntimeEnabled()
    && originLane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW
    && version === 1
    && !suppressNotification;

  await sql.begin(async (tx) => {
    // Take the review row lock as the transaction's FIRST statement
    // (run-spine.ts lock-ordering contract). It must precede the responses
    // INSERT below: that INSERT's FK on review_id takes an implicit
    // FOR KEY SHARE on the reviews tuple, and upgrading share → FOR UPDATE
    // later deadlocks against concurrent FOR UPDATE waiters (content-changed
    // ingest, edit-publish/failed-hook, or another persist for the same
    // review). Taking FOR UPDATE first subsumes the later KEY SHARE. Bonus:
    // the auto-approval content-hash re-read further down happens under this
    // lock, so it cannot race a concurrent content-changed ingest.
    const [reviewLock] = await tx<{ id: string }[]>`
      SELECT id FROM reviews
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

    // Structural non-candidates get their decision without touching the DB:
    // no runtime-state read (074 columns stay unread on flag-off deploys,
    // finding 5) and no fallback log — logAutoApprovalFallbackIfNeeded's
    // isAutoCandidate narrowing requires the live_ingest_new lane AND a
    // configured policy, and structural blocks either fail the lane check or
    // (flag off / regen / suppressed) are not the runtime-prerequisite story
    // that log exists for (spec §15).
    let runtimeState: AutoApprovalRuntimeState | null = null;
    let autoDecision: AutoApprovalDecision;
    if (isAutoApprovalCandidate) {
      // FP: sequential reads on the shared tx after the moderation/hold write in the same sql.begin; runtime-state re-read is ordered against the prior tx writes, not independent.
      // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
      runtimeState = await loadAutoApprovalRuntimeState(tx, {
        reviewId,
        businessId,
        accountId,
      });
      autoDecision = evaluateAutoApprovalCandidate({
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
    } else {
      autoDecision = structurallyBlockedDecision({ originLane, version, suppressNotification });
    }

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
      return;
    }

    // Backfill suppression (spec §4.6, §6.7) OR a high-severity flag both skip
    // the approval notification.
    if (suppressNotification || held) {
      return;
    }

    await enqueueSendNotification(tx, {
      responseId,
      businessId,
      correlationId,
    });
  });

  return responseId;
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

  // Narrow to genuine auto candidates: a draft on the auto-eligible lane whose
  // account has a policy configured, so the only thing standing between it and
  // an auto-post is a runtime prerequisite (provider moderation, subscription,
  // active connection/location, review-hash freshness, or the runtime flag).
  // Bad-lane / no-policy drafts were never going to auto and would otherwise log
  // on every generated draft while AUTO_APPROVAL_ENABLED is on (spec §15).
  const isAutoCandidate =
    originLane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW
    && runtimeState.effectivePolicy.threshold !== null;
  if (!isAutoCandidate) {
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
 * Records moderation metadata on the final output's api_costs row and, for a
 * high-severity flag, HOLDS the draft by writing a flagged_responses row. Runs
 * on the OPEN transaction `tx` so the hold stays atomic with the response
 * INSERT (invariant #4). Returns whether the draft was held (high-severity),
 * which the caller uses to skip the send_notification enqueue.
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
    await tx`
      INSERT INTO flagged_responses (
        id, response_id, account_id, business_id, review_id, api_cost_id,
        source, reason, severity, status
      ) VALUES (
        ${uuidv7()}, ${responseId}, ${accountId}, ${businessId}, ${reviewId}, ${moderatedCostId ?? null},
        ${moderation.source ?? 'local_regex'}, ${moderation.reason}, ${moderation.severity}, ${FLAGGED_RESPONSE_STATUS_OPEN}
      )
    `;
  }

  return flaggedHigh;
}
