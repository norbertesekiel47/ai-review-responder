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
  type SendNotificationPayload,
} from '../../../src/lib/shared/worker-types';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { enqueuePublishResponse } from '../../../src/lib/shared/job-outbox-helpers';
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
const AGGREGATE_TYPE_RESPONSE = 'response';

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
  logger?: Pick<WorkerLogger, 'log'>;
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
          policy_id: runtimeState.effectivePolicy.policyId,
          policy_source: runtimeState.effectivePolicy.source,
          resolved_min_star: runtimeState.effectivePolicy.threshold,
          star_rating: runtimeState.currentStarRating,
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

    const notifyPayload: SendNotificationPayload = {
      response_id: responseId,
      business_id: businessId,
      correlation_id: correlationId,
    };

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, ${QUEUE_NAMES.SEND_NOTIFICATION}, ${AGGREGATE_TYPE_RESPONSE}, ${responseId},
        ${jsonb(notifyPayload)}, 'pending'
      )
    `;
  });

  return responseId;
}

function logAutoApprovalFallbackIfNeeded(input: {
  logger: Pick<WorkerLogger, 'log'> | undefined;
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
  if (!logger || autoDecision.approved || autoDecision.blockReasons.length === 0) {
    return;
  }

  const inAutoDecisionSurface =
    originLane === GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW
    || runtimeState.effectivePolicy.threshold !== null
    || autoDecision.runtimeEnabled;
  if (!inAutoDecisionSurface) {
    return;
  }

  logger.log('Auto-approval fallback to owner review', {
    response_id: responseId,
    review_id: reviewId,
    business_id: businessId,
    response_version: version,
    origin_lane: originLane,
    block_reasons: autoDecision.blockReasons,
    runtime_enabled: autoDecision.runtimeEnabled,
    provider_moderation_enabled: autoDecision.providerModerationEnabled,
    provider_status: moderation.providerStatus,
    review_content_hash_matched: autoDecision.reviewContentHashMatched,
    publisher_subscription_allowed: autoDecision.publisherSubscription.allowed,
    publisher_subscription_reason: autoDecision.publisherSubscription.allowed
      ? null
      : autoDecision.publisherSubscription.reason,
    active_zernio_connection: runtimeState.activeZernioConnectionNow,
    active_location: runtimeState.activeLocationNow,
    policy_source: runtimeState.effectivePolicy.source,
    resolved_min_star: runtimeState.effectivePolicy.threshold,
  });
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
