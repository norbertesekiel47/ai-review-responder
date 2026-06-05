// worker/jobs/response-generation/persist.ts
//
// Invariant #4 transactional boundary for the response generator. Persists the
// generated response, links its api_costs row(s), records moderation metadata,
// and — for a high-severity moderation flag — HOLDS the draft (writes a
// flagged_responses row and skips the send_notification outbox enqueue) in the
// SAME transaction as response persistence. The moderation-hold + notification
// skip must never split from the INSERT. See CLAUDE.md invariant #4.

import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { sql, jsonb } from '../../../src/lib/db/server';
import type { ModerationDecision } from '../../../src/lib/moderation/output-filter';
import type { GenerationResult } from '../../../src/lib/responses/types';
import { APPROVAL_METHOD } from '../../../src/lib/auto-approval/types';
import {
  GENERATE_RESPONSE_ORIGIN_LANE,
  type GenerateResponseOriginLane,
} from '../../../src/lib/shared/worker-types';
import {
  enqueuePublishResponse,
  enqueueSendNotification,
} from '../../../src/lib/shared/job-outbox-helpers';
import { insertAuditLogAutoPolicy } from '../../../src/lib/approval/audit';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import {
  type AutoApprovalDecision,
  type AutoApprovalRuntimeState,
  evaluateAutoApprovalCandidate,
  loadAutoApprovalRuntimeState,
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
  logger: Pick<WorkerLogger, 'log'>;
}

export async function persistResponseAndNotify(input: PersistResponseInput): Promise<string> {
  const {
    result, retryCostId, reviewId, businessId, version,
    correlationId, suppressNotification, originLane, loadedReviewContentHash,
    moderation, accountId, logger,
  } = input;

  const responseId = uuidv7();
  // Moderation describes the FINAL output; when an avoid-facts retry happened,
  // the final text's cost row is the retry's row.
  const moderatedCostId = retryCostId ?? result.apiCostId;

  await sql.begin(async (tx) => {
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

    const runtimeState = await loadAutoApprovalRuntimeState(tx, {
      reviewId,
      businessId,
      accountId,
    });
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
      accountPastDueAt: runtimeState.accountPastDueAt,
      accountFlags: runtimeState.accountFlags,
      activeLocationNow: runtimeState.activeLocationNow,
      activeZernioConnectionNow: runtimeState.activeZernioConnectionNow,
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

    if (autoDecision.approved) {
      await tx`
        UPDATE responses
        SET status = ${RESPONSE_STATUS_APPROVED},
            approval_method = ${APPROVAL_METHOD.AUTO_POLICY},
            approved_text = ${result.responseText},
            approved_at = NOW(),
            posting_error = NULL,
            updated_at = NOW()
        WHERE id = ${responseId}
          AND business_id = ${businessId}
          AND status = ${RESPONSE_STATUS_PENDING_APPROVAL}
      `;

      await insertAuditLogAutoPolicy(tx, {
        responseId,
        businessId,
        responseTextAtApproval: result.responseText,
        metadata: {
          ...buildAutoApprovalDecisionSummary({ autoDecision, runtimeState, originLane, moderation, version }),
          policy_id: runtimeState.effectivePolicy.policyId,
          star_rating: runtimeState.currentStarRating,
          correlation_id: correlationId,
        },
      });

      await enqueuePublishResponse(tx, {
        responseId,
        businessId,
        correlationId,
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
}) {
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
        moderation_categories = ${jsonb(moderation.categories)},
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
