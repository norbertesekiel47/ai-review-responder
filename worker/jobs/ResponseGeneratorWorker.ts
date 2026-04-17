import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import { sanitizeText } from '../../src/lib/shared/sanitize';
import { getApprovedResponsePairs } from '../../src/lib/responses/voice-learning';
import { generateResponse } from '../../src/lib/responses/generator';
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

export async function handleResponseGeneration(
  job: Job<GenerateResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponseGeneratorWorker]', job.data.correlation_id);
  const { review_id, business_id, version } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

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
    await markOutboxFailed(outboxId, 'review_not_found');
    return;
  }

  const [business] = await sql<{
    id: string;
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
    updated_at: Date;
  }[]>`
    SELECT id, name, category, tone, products_services, staff_names,
           highlight_facts, avoid_facts, sample_responses,
           subscription_status, subscription_tier, updated_at
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    logger.warn(`Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found');
    return;
  }

  // ── Step 2: Subscription guard ───────────────────────────────────────
  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'generator',
  );

  if (!subCheck.allowed) {
    logger.log(`Business ${business_id} skipped: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
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
  // JSONB parsing guard: Postgres.js may return TEXT[] as strings through PgBouncer
  const parseArray = (val: unknown): string[] => {
    if (Array.isArray(val)) return val as string[];
    if (typeof val === 'string') {
      try { return JSON.parse(val) as string[]; } catch { return []; }
    }
    return [];
  };

  const businessContext: BusinessContext = {
    id: business.id,
    name: business.name,
    category: business.category,
    tone: business.tone,
    productsServices: business.products_services,
    staffNames: parseArray(business.staff_names),
    highlightFacts: parseArray(business.highlight_facts),
    avoidFacts: parseArray(business.avoid_facts),
    sampleResponses: parseArray(business.sample_responses),
    subscriptionTier: business.subscription_tier as BusinessContext['subscriptionTier'],
  };

  // ── Step 5: Idempotency check — previous attempt may have committed ──
  // The schema enforces UNIQUE (review_id, version). If a previous attempt
  // committed the response + notification outbox but crashed before
  // markOutboxCompleted, detect this BEFORE spending on LLM calls or
  // reserving cost. The generator's Redis cache may have expired.
  const [existingResponse] = await sql<{ id: string }[]>`
    SELECT id FROM responses WHERE review_id = ${review_id} AND version = ${version}
  `;

  if (existingResponse) {
    logger.log(`Response already exists for review ${review_id} v${version}, completing outbox`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // ── Step 6: Voice learning ──────────────────────────────────────────
  const voiceExamples: VoiceExample[] = await getApprovedResponsePairs(business_id);

  // ── Step 7: Regeneration budget check ───────────────────────────────
  if (version > 1) {
    try {
      await checkRegenBudget(review_id);
    } catch (err) {
      if (err instanceof RegenBudgetExceededError) {
        logger.warn(`Regen budget exceeded for review ${review_id}`);
        await markOutboxFailed(outboxId, err.message);
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
        { mode: 'production', reviewId: review_id, version, businessId: business_id, subscriptionTier: businessContext.subscriptionTier },
      );
    } else {
      result = await generateResponse(
        normalizedReview,
        businessContext,
        voiceExamples,
        { mode: 'production', reviewId: review_id, version, businessId: business_id, subscriptionTier: businessContext.subscriptionTier },
      );
    }
  } catch (err) {
    if (err instanceof CostLimitExceededError || err instanceof GlobalCostLimitExceededError) {
      logger.warn(`Cost limit exceeded for business ${business_id}: ${err.message}`);
      await markOutboxFailed(outboxId, err.message);
      return;
    }
    if (err instanceof ConcurrencyLimitExceededError) {
      // Transient — other jobs will finish, then this one can proceed
      throw err;
    }
    // LLM failures (both providers down) or other errors
    logger.error(`Generation failed for review ${review_id}: ${err instanceof Error ? err.message : err}`);
    await markOutboxFailed(outboxId, `generation_failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // ── Step 8: Avoid-facts guardrail ───────────────────────────────────
  result = await applyAvoidFactsGuardrail(
    result, businessContext, normalizedReview, voiceExamples,
    { reviewId: review_id, version, businessId: business_id },
    logger,
  );

  // ── Step 9: Persist response + outbox + cost link in one transaction ─
  const responseId = await persistResponseAndNotify(
    result, review_id, business_id, version, job.data.correlation_id,
  );
  // DB transaction failure throws for BullMQ retry (transient)

  // ── Step 10: Complete outbox ─────────────────────────────────────────
  await markOutboxCompleted(outboxId);
  logger.log(`Response ${responseId} generated for review ${review_id} (v${version})`);
}

// ── Avoid-facts guardrail ───────────────────────────────────────────────

async function applyAvoidFactsGuardrail(
  result: GenerationResult,
  businessContext: BusinessContext,
  normalizedReview: NormalizedReview,
  voiceExamples: VoiceExample[],
  ids: { reviewId: string; version: number; businessId: string },
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
  correlationId?: string,
): Promise<string> {
  const responseId = uuidv7();

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

    const retryCostId = (result as any)._retryCostId as string | undefined;
    if (retryCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${retryCostId}
      `;
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
        ${JSON.stringify(notifyPayload)}::jsonb, 'pending'
      )
    `;
  });

  return responseId;
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
