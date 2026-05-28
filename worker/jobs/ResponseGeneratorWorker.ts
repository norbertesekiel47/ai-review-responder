import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { sanitizeText } from '../../src/lib/shared/sanitize';
import { moderateResponse } from '../../src/lib/moderation/moderate';
import type { GenerateResponsePayload } from '../../src/lib/shared/worker-types';
import type { NormalizedReview } from '../../src/lib/reviews/types';
import type { BusinessContext } from '../../src/lib/responses/types';
import { createWorkerLogger, type WorkerLogger } from '../../src/lib/shared/logger';
import { mergeLogContext } from '../../src/lib/shared/log-context';
import { parseDbArray } from '../../src/lib/shared/db-array';
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';
import { maybeEnqueueFirstResponseDrafted } from './response-generation/analytics';
import { persistResponseAndNotify } from './response-generation/persist';
import { generateDraft } from './response-generation/generate-draft';

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

  // ── Generate draft (cost-guard → generate → avoid-facts guardrail) ───
  // Retryable errors (concurrency / transient LLM) throw out of generateDraft
  // and propagate to BullMQ for retry. Permanent failures return { failed }.
  const draft = await generateDraft(
    { accountId: business.account_id, normalizedReview, businessContext },
    { reviewId: review_id, version, businessId },
    logger,
  );
  if (draft.kind === 'failed') {
    await markOutboxFailed(outboxId, draft.reason, outboxAttempt);
    return;
  }

  // ── Output moderation (local rules always; provider if configured) ───
  const moderation = await moderateResponse(draft.result.responseText);

  // ── Step 9: Persist response + outbox + cost link + moderation in one tx ─
  const responseId = await persistResponseAndNotify({
    result: draft.result,
    retryCostId: draft.retryCostId,
    reviewId: review_id,
    businessId,
    version,
    correlationId: job.data.correlation_id,
    suppressNotification: job.data.suppress_notification === true,
    moderation,
    accountId: business.account_id,
  });
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
