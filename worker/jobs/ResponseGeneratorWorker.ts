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

const LOG_PREFIX = '[ResponseGeneratorWorker]';

export async function handleResponseGeneration(
  job: Job<GenerateResponsePayload>,
): Promise<void> {
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
    console.warn(`${LOG_PREFIX} Review ${review_id} not found`);
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
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
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
    console.log(`${LOG_PREFIX} Business ${business_id} skipped: ${subCheck.reason}`);
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
    console.log(`${LOG_PREFIX} Response already exists for review ${review_id} v${version}, completing outbox`);
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
        console.warn(`${LOG_PREFIX} Regen budget exceeded for review ${review_id}`);
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
      console.warn(`${LOG_PREFIX} Cost limit exceeded for business ${business_id}: ${err.message}`);
      await markOutboxFailed(outboxId, err.message);
      return;
    }
    if (err instanceof ConcurrencyLimitExceededError) {
      // Transient — other jobs will finish, then this one can proceed
      throw err;
    }
    // LLM failures (both providers down) or other errors
    console.error(`${LOG_PREFIX} Generation failed for review ${review_id}: ${err instanceof Error ? err.message : err}`);
    await markOutboxFailed(outboxId, `generation_failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // ── Step 8: Avoid-facts guardrail ───────────────────────────────────
  const avoidFacts = businessContext.avoidFacts;
  if (avoidFacts.length > 0) {
    const violation = findAvoidFactViolation(result.responseText, avoidFacts);
    if (violation) {
      console.warn(`${LOG_PREFIX} Avoid-fact violation for review ${review_id}: "${violation}". Regenerating once.`);
      try {
        // skipCache: true so the idempotent cache doesn't return the violating first result
        const retryOpts = { mode: 'production' as const, reviewId: review_id, version, businessId: business_id, subscriptionTier: businessContext.subscriptionTier, skipCache: true };
        const retryResult = isMockMode()
          ? await generateMockResponse(normalizedReview, businessContext, voiceExamples, retryOpts)
          : await generateResponse(normalizedReview, businessContext, voiceExamples, retryOpts);

        // Accumulate cost from both attempts
        result = {
          ...retryResult,
          costUsd: result.costUsd + retryResult.costUsd,
        };

        // Overwrite the cache with the accepted retry result so the
        // polluted first-attempt entry doesn't persist.
        try {
          await setCachedGeneration(review_id, version, JSON.stringify({
            responseText: result.responseText,
            language: result.language,
            provider: result.provider,
            model: result.model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
          }));
        } catch {
          // Best-effort — cache TTL will expire the polluted entry eventually
        }
      } catch {
        // Best-effort retry failed — use the original result
        console.warn(`${LOG_PREFIX} Avoid-fact retry failed for review ${review_id}, using original response`);
      }
    }
  }

  // ── Step 10: Persist response + outbox + cost link in one transaction ─
  const responseId = uuidv7();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO responses (
        id, review_id, business_id, response_text, response_language,
        version, status, original_draft_text,
        llm_provider, llm_model, prompt_tokens, completion_tokens
      ) VALUES (
        ${responseId}, ${review_id}, ${business_id}, ${result.responseText}, ${result.language},
        ${version}, 'pending_approval', ${result.responseText},
        ${result.provider}, ${result.model}, ${result.usage.promptTokens}, ${result.usage.completionTokens}
      )
    `;

    // Link api_costs row to the new response (inside the transaction so
    // response_id is never left null on a successful commit)
    if (result.apiCostId) {
      await tx`
        UPDATE api_costs SET response_id = ${responseId} WHERE id = ${result.apiCostId}
      `;
    }

    const notifyPayload: SendNotificationPayload = {
      response_id: responseId,
      business_id: business_id,
    };

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'send_notification', 'response', ${responseId},
        ${JSON.stringify(notifyPayload)}::jsonb, 'pending'
      )
    `;
  });
  // DB transaction failure throws for BullMQ retry (transient)

  // ── Step 10: Complete outbox ─────────────────────────────────────────
  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Response ${responseId} generated for review ${review_id} (v${version})`);
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
