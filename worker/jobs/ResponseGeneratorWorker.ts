import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import { sanitizeText } from '../../src/lib/shared/sanitize';
import { getApprovedResponsePairs } from '../../src/lib/responses/voice-learning';
import { generateResponse, TransientLLMError } from '../../src/lib/responses/generator';
import { moderateResponse } from '../../src/lib/moderation/moderate';
import type { ModerationDecision } from '../../src/lib/moderation/output-filter';
import { generateMockResponse } from '../../src/lib/responses/mock-generator';
import {
  CostLimitExceededError,
  GlobalCostLimitExceededError,
  ConcurrencyLimitExceededError,
  RegenBudgetExceededError,
  checkRegenBudget,
  setCachedGeneration,
} from '../../src/lib/costs/tracker';
import type { GenerateResponsePayload, SendNotificationPayload } from '../../src/lib/shared/worker-types';
import type { NormalizedReview } from '../../src/lib/reviews/types';
import type { BusinessContext, GenerationResult, VoiceExample } from '../../src/lib/responses/types';
import { createWorkerLogger, type WorkerLogger } from '../../src/lib/shared/logger';
import { mergeLogContext } from '../../src/lib/shared/log-context';
import { parseDbArray } from '../../src/lib/shared/db-array';
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';
import { enqueueAnalyticsEvent } from '../../src/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '../../src/lib/analytics/events';

export async function handleResponseGeneration(
  job: Job<GenerateResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponseGeneratorWorker]', job.data.correlation_id);
  const { review_id, version } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  mergeLogContext({ outbox_id: outboxId });

  // ── Step 1: Read review and business ─────────────────────────────────
  const [review] = await sql<{
    id: string;
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    review_date: string;
    detected_language: string;
  }[]>`
    SELECT id, reviewer_name, star_rating, review_text, review_date, detected_language
    FROM reviews WHERE id = ${review_id}
  `;

  if (!review) {
    logger.warn(`Review ${review_id} not found`);
    await markOutboxFailed(outboxId, 'review_not_found', outboxAttempt);
    return;
  }

  const [business] = await sql<{
    id: string;
    account_id: string;
    name: string;
    category: string | null;
    tone: string;
    products_services: string | null;
    staff_names: string[] | null;
    highlight_facts: string[] | null;
    avoid_facts: string[] | null;
    sample_responses: string[] | null;
    subscription_status: string;
    subscription_tier: string;
    account_past_due_at: Date | null;
    account_flags: AccountFlagsInput;
  }[]>`
    SELECT b.id, b.account_id, b.name, b.category, b.tone, b.products_services, b.staff_names,
           b.highlight_facts, b.avoid_facts, b.sample_responses,
           a.subscription_status, a.subscription_tier,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
  `;

  if (!business) {
    logger.warn(`Business ${businessId} not found`);
    await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  mergeLogContext({ account_id: business.account_id });

  // ── Step 2: Subscription guard ───────────────────────────────────────
  const subCheck = checkSubscription({
    status: business.subscription_status,
    pastDueAt: business.account_past_due_at,
    accountFlags: business.account_flags ?? {},
    workerType: 'generator',
  });

  if (!subCheck.allowed) {
    logger.log(`Business ${businessId} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 3: Build NormalizedReview with sanitized text ────────────────
  const normalizedReview: NormalizedReview = {
    reviewerName: review.reviewer_name,
    starRating: review.star_rating,
    reviewText: review.review_text ? sanitizeText(review.review_text) : null,
    reviewDate: review.review_date,
    detectedLanguage: review.detected_language,
  };

  // ── Step 4: Build BusinessContext from DB row ────────────────────────
  const businessContext: BusinessContext = {
    id: business.id,
    name: business.name,
    category: business.category,
    tone: business.tone,
    productsServices: business.products_services,
    staffNames: parseDbArray(business.staff_names),
    highlightFacts: parseDbArray(business.highlight_facts),
    avoidFacts: parseDbArray(business.avoid_facts),
    sampleResponses: parseDbArray(business.sample_responses),
    subscriptionTier: business.subscription_tier as BusinessContext['subscriptionTier'],
  };

  // ── Step 5: Idempotency check — previous attempt may have committed ──
  // The schema enforces UNIQUE (review_id, version). If a previous attempt
  // committed the response + notification outbox but crashed before
  // markOutboxCompleted, detect this BEFORE spending on LLM calls or
  // reserving cost. The generator's Redis cache may have expired.
  const [existingResponse] = await sql<{ id: string; business_id: string; account_id: string }[]>`
    SELECT r.id, r.business_id, b.account_id
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.review_id = ${review_id}
      AND r.version = ${version}
  `;

  if (existingResponse) {
    logger.log(`Response already exists for review ${review_id} v${version}, completing outbox`);
    await maybeEnqueueFirstResponseDrafted({
      accountId: existingResponse.account_id,
      businessId: existingResponse.business_id,
      responseId: existingResponse.id,
      reviewId: review_id,
      logger,
    });
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 6: Voice learning ──────────────────────────────────────────
  const voiceExamples: VoiceExample[] = await getApprovedResponsePairs(businessId);

  // ── Step 7: Regeneration budget check ───────────────────────────────
  if (version > 1) {
    try {
      await checkRegenBudget(review_id);
    } catch (err) {
      if (err instanceof RegenBudgetExceededError) {
        logger.warn(`Regen budget exceeded for review ${review_id}`);
        await markOutboxFailed(outboxId, err.message, outboxAttempt);
        return;
      }
      throw err;
    }
  }

  // ── Step 7: Generate response ───────────────────────────────────────
  let result: GenerationResult;
  try {
    if (isMockMode()) {
      result = await generateMockResponse(
        normalizedReview,
        businessContext,
        voiceExamples,
        { mode: 'production', reviewId: review_id, version, businessId: businessId, subscriptionTier: businessContext.subscriptionTier, accountId: business.account_id },
      );
    } else {
      result = await generateResponse(
        normalizedReview,
        businessContext,
        voiceExamples,
        { mode: 'production', reviewId: review_id, version, businessId: businessId, subscriptionTier: businessContext.subscriptionTier, accountId: business.account_id },
      );
    }
  } catch (err) {
    if (err instanceof CostLimitExceededError || err instanceof GlobalCostLimitExceededError) {
      logger.warn(`Cost limit exceeded for business ${businessId}: ${err.message}`);
      await markOutboxFailed(outboxId, err.message, outboxAttempt);
      return;
    }
    if (err instanceof ConcurrencyLimitExceededError) {
      // Transient — other jobs will finish, then this one can proceed
      throw err;
    }
    if (err instanceof TransientLLMError) {
      // Provider outage / rate-limit / network — rethrow so BullMQ retries
      // (3 attempts + exponential backoff) and, if those exhaust, the
      // outbox watchdog re-dispatches after the 1h stale window.
      logger.warn(`Transient LLM error for review ${review_id} (will retry): ${err.message}`);
      throw err;
    }
    // Permanent LLM/config error (auth, bad request, validation)
    logger.error(`Generation failed for review ${review_id}: ${err instanceof Error ? err.message : err}`);
    await markOutboxFailed(outboxId, `generation_failed: ${err instanceof Error ? err.message : err}`, outboxAttempt);
    return;
  }

  // ── Step 8: Avoid-facts guardrail ───────────────────────────────────
  // Guardrail errors (retry still violates, or retry LLM call itself fails)
  // must mark the outbox failed and RETURN — not throw. Throwing causes
  // BullMQ to retry the whole job while the outbox stays non-terminal
  // until the watchdog recovers it, and each retry spends more on LLM
  // calls for a problem that won't resolve on its own (the avoid_facts
  // config needs an admin fix, not a retry).
  try {
    result = await applyAvoidFactsGuardrail(
      result, businessContext, normalizedReview, voiceExamples,
      { reviewId: review_id, version, businessId: businessId, accountId: business.account_id },
      logger,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Avoid-facts guardrail failed for review ${review_id}: ${message}`);
    await markOutboxFailed(outboxId, `guardrail_failed: ${message}`, outboxAttempt);
    return;
  }

  // ── Step 8.5: Output moderation (local rules always; provider if configured) ─
  const moderation = await moderateResponse(result.responseText);

  // ── Step 9: Persist response + outbox + cost link + moderation in one tx ─
  const responseId = await persistResponseAndNotify(
    result, review_id, businessId, version, job.data.correlation_id,
    job.data.suppress_notification === true,
    moderation, business.account_id,
  );
  // DB transaction failure throws for BullMQ retry (transient)

  await maybeEnqueueFirstResponseDrafted({
    accountId: business.account_id,
    businessId,
    responseId,
    reviewId: review_id,
    logger,
  });

  // ── Step 10: Complete outbox ─────────────────────────────────────────
  await markOutboxCompleted(outboxId, outboxAttempt);
  logger.log(`Response ${responseId} generated for review ${review_id} (v${version})`);
}

// ── Avoid-facts guardrail ───────────────────────────────────────────────

async function applyAvoidFactsGuardrail(
  result: GenerationResult,
  businessContext: BusinessContext,
  normalizedReview: NormalizedReview,
  voiceExamples: VoiceExample[],
  ids: { reviewId: string; version: number; businessId: string; accountId: string },
  logger: WorkerLogger,
): Promise<GenerationResult> {
  const { avoidFacts } = businessContext;
  if (avoidFacts.length === 0) return result;

  const violation = findAvoidFactViolation(result.responseText, avoidFacts);
  if (!violation) return result;

  logger.warn(`Avoid-fact violation for review ${ids.reviewId}: "${violation}". Regenerating once.`);

  try {
    const retryOpts = {
      mode: 'production' as const,
      reviewId: ids.reviewId,
      version: ids.version,
      businessId: ids.businessId,
      subscriptionTier: businessContext.subscriptionTier,
      accountId: ids.accountId,
      skipCache: true,
    };
    const retryResult = isMockMode()
      ? await generateMockResponse(normalizedReview, businessContext, voiceExamples, retryOpts)
      : await generateResponse(normalizedReview, businessContext, voiceExamples, retryOpts);

    const merged: GenerationResult = {
      ...retryResult,
      costUsd: result.costUsd + retryResult.costUsd,
      apiCostId: result.apiCostId, // Restore original (retryResult spread overwrote it)
    };
    // Attach retry cost ID separately for persistResponseAndNotify
    (merged as any)._retryCostId = retryResult.apiCostId;

    // Overwrite the cache so the polluted first-attempt entry doesn't persist
    try {
      await setCachedGeneration(ids.reviewId, ids.version, JSON.stringify({
        responseText: merged.responseText,
        language: merged.language,
        provider: merged.provider,
        model: merged.model,
        promptTokens: merged.usage.promptTokens,
        completionTokens: merged.usage.completionTokens,
      }));
    } catch {
      // Best-effort — cache TTL will expire the polluted entry eventually
    }

    // Re-check the retry for violations
    const retryViolation = findAvoidFactViolation(merged.responseText, avoidFacts);
    if (retryViolation) {
      throw new Error(
        `Avoid-fact violation persists after retry for review ${ids.reviewId}: "${retryViolation}"`,
      );
    }

    return merged;
  } catch (err) {
    // Retry failed or still violates — do NOT fall back to the violating draft.
    // Throw so the worker marks this as failed and creates a review exception.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Avoid-fact guardrail failed for review ${ids.reviewId}: ${message}`);
  }
}

// ── Persist response + notification outbox ───────────────────────────────

async function persistResponseAndNotify(
  result: GenerationResult,
  reviewId: string,
  businessId: string,
  version: number,
  correlationId: string | undefined,
  suppressNotification: boolean,
  moderation: ModerationDecision,
  accountId: string,
): Promise<string> {
  const responseId = uuidv7();
  const retryCostId = (result as any)._retryCostId as string | undefined;
  // Moderation describes the FINAL output; when an avoid-facts retry happened,
  // the final text's cost row is the retry's row.
  const moderatedCostId = retryCostId ?? result.apiCostId;
  const flaggedHigh = moderation.flagged && moderation.severity === 'high';

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO responses (
        id, review_id, business_id, response_text, response_language,
        version, status, original_draft_text,
        llm_provider, llm_model, prompt_tokens, completion_tokens
      ) VALUES (
        ${responseId}, ${reviewId}, ${businessId}, ${result.responseText}, ${result.language},
        ${version}, 'pending_approval', ${result.responseText},
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

    // Record moderation metadata on the cost row for the final output. Excerpt
    // is for operational triage only — full text already lives on responses.
    if (moderatedCostId) {
      await tx`
        UPDATE api_costs SET
          moderation_score = ${moderation.score},
          moderation_categories = ${jsonb(moderation.categories)},
          flagged = ${moderation.flagged},
          flag_reason = ${moderation.reason},
          output_excerpt = ${result.responseText.slice(0, 200)}
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
          ${moderation.source ?? 'local_regex'}, ${moderation.reason}, ${moderation.severity}, ${'open'}
        )
      `;
    }

    // Backfill suppression (spec §4.6, §6.7) OR a high-severity flag both skip
    // the approval notification.
    if (suppressNotification || flaggedHigh) {
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
        ${uuidv7()}, 'send_notification', 'response', ${responseId},
        ${jsonb(notifyPayload)}, 'pending'
      )
    `;
  });

  return responseId;
}

// Best-effort, intentionally outside the response-creation transaction: this
// runs AFTER the response commits so it can detect "first draft for the account"
// against committed rows. Idempotency across BullMQ retries-after-commit is
// guaranteed by the account-scoped event_key + ON CONFLICT (event_key) DO
// NOTHING in enqueueAnalyticsEvent, so a re-run cannot double-count. Analytics
// must never fail response generation, hence the swallowed catch.
async function maybeEnqueueFirstResponseDrafted(input: {
  accountId: string;
  businessId: string;
  responseId: string;
  reviewId: string;
  logger?: Pick<Console, 'warn'>;
}): Promise<void> {
  try {
    const [row] = await sql<{ earlier_exists: boolean; email_verified_at: Date | null }[]>`
      SELECT
        EXISTS (
          SELECT 1
          FROM responses r2
          JOIN businesses b2 ON b2.id = r2.business_id
          WHERE b2.account_id = ${input.accountId}::uuid
            AND r2.id <> ${input.responseId}::uuid
            AND r2.created_at IS NOT NULL
          LIMIT 1
        ) AS earlier_exists,
        (
          SELECT occurred_at
          FROM analytics_events
          WHERE event_name = 'email_verified'
            AND account_id = ${input.accountId}::uuid
          ORDER BY occurred_at ASC
          LIMIT 1
        ) AS email_verified_at
    `;
    if (row?.earlier_exists) return;

    const minutesToFirstDraft = row?.email_verified_at
      ? Math.max(0, (Date.now() - new Date(row.email_verified_at).getTime()) / 60_000)
      : null;

    await enqueueAnalyticsEvent({
      eventName: 'first_response_drafted',
      eventKey: makeAnalyticsEventKey('first_response_drafted', [input.accountId]),
      distinctId: input.accountId,
      accountId: input.accountId,
      businessId: input.businessId,
      properties: {
        account_id: input.accountId,
        business_id: input.businessId,
        response_id: input.responseId,
        review_id: input.reviewId,
        minutes_to_first_draft: minutesToFirstDraft === null ? null : Number(minutesToFirstDraft.toFixed(2)),
      },
    });
  } catch (err) {
    input.logger?.warn(`first_response_drafted enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function findAvoidFactViolation(text: string, avoidFacts: string[]): string | null {
  const lower = text.toLowerCase();
  for (const fact of avoidFacts) {
    if (fact && lower.includes(fact.toLowerCase())) {
      return fact;
    }
  }
  return null;
}
