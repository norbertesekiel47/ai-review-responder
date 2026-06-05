import type { Job } from 'bullmq';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { moderateResponse } from '../../src/lib/moderation/moderate';
import type { GenerateResponsePayload } from '../../src/lib/shared/worker-types';
import { normalizeGenerateResponsePayload } from '../../src/lib/shared/job-outbox-helpers';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { mergeLogContext } from '../../src/lib/shared/log-context';
import { asLocationId } from '../../src/lib/shared/ids';
import { loadGenerationContext } from './response-generation/load-context';
import { generateDraft } from './response-generation/generate-draft';
import { persistResponseAndNotify } from './response-generation/persist';
import { maybeEnqueueFirstResponseDrafted } from './response-generation/analytics';

export async function handleResponseGeneration(
  job: Job<GenerateResponsePayload>,
): Promise<void> {
  const payload = normalizeGenerateResponsePayload(job.data);
  const logger = createWorkerLogger('[ResponseGeneratorWorker]', payload.correlationId);
  const { reviewId, version } = payload;
  // Brand the raw job-data id at the entry point.
  const businessId = asLocationId(payload.businessId);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  mergeLogContext({ outbox_id: outboxId });
  if (payload.unknownOriginLane) {
    logger.warn('Unknown generate_response origin_lane; falling back to manual approval', {
      origin_lane: payload.unknownOriginLane,
    });
  }

  // ── Load review + business, guard subscription, check idempotency ────
  const loaded = await loadGenerationContext({ reviewId, businessId, version });
  switch (loaded.kind) {
    case 'review_not_found':
      logger.warn(`Review ${reviewId} not found`);
      await markOutboxFailed(outboxId, 'review_not_found', outboxAttempt);
      return;
    case 'business_not_found':
      logger.warn(`Business ${businessId} not found`);
      await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
      return;
    case 'subscription_blocked':
      logger.log(`Business ${businessId} skipped: ${loaded.reason}`);
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    case 'already_exists':
      logger.log(`Response already exists for review ${reviewId} v${version}, completing outbox`);
      await maybeEnqueueFirstResponseDrafted({
        accountId: loaded.existing.accountId,
        businessId: loaded.existing.businessId,
        responseId: loaded.existing.id,
        reviewId,
        logger,
      });
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
  }

  const { ctx } = loaded;

  // ── Generate draft (cost-guard → generate → avoid-facts guardrail) ───
  // Retryable errors (concurrency / transient LLM) throw out of generateDraft
  // and propagate to BullMQ for retry. Permanent failures return { kind: 'failed' }.
  const draft = await generateDraft(ctx, { reviewId, version, businessId }, logger);
  if (draft.kind === 'failed') {
    await markOutboxFailed(outboxId, draft.reason, outboxAttempt);
    return;
  }

  // ── Output moderation (local rules always; provider if configured) ───
  const moderation = await moderateResponse(draft.result.responseText);

  // ── Persist response + outbox + cost link + moderation hold in one tx ─
  // (invariant #4: a high-severity flag holds the draft + skips notification,
  // atomically with response persistence). DB failure throws → BullMQ retry.
  const responseId = await persistResponseAndNotify({
    result: draft.result,
    retryCostId: draft.retryCostId,
    reviewId,
    businessId,
    version,
    correlationId: payload.correlationId,
    suppressNotification: payload.suppressNotification,
    originLane: payload.originLane,
    loadedReviewContentHash: ctx.loadedReviewContentHash,
    moderation,
    accountId: ctx.accountId,
    logger,
  });

  await maybeEnqueueFirstResponseDrafted({
    accountId: ctx.accountId,
    businessId,
    responseId,
    reviewId,
    logger,
  });

  // ── Complete outbox ──────────────────────────────────────────────────
  await markOutboxCompleted(outboxId, outboxAttempt);
  logger.log(`Response ${responseId} generated for review ${reviewId} (v${version})`);
}
