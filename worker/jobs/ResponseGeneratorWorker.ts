import type { Job } from 'bullmq';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { moderateResponse } from '../../src/lib/moderation/moderate';
import type { GenerateResponsePayload } from '../../src/lib/shared/worker-types';
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
  const logger = createWorkerLogger('[ResponseGeneratorWorker]', job.data.correlation_id);
  const { review_id, version } = job.data;
  const businessId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  mergeLogContext({ outbox_id: outboxId });

  // ── Load review + business, guard subscription, check idempotency ────
  const loaded = await loadGenerationContext({ reviewId: review_id, businessId, version });
  switch (loaded.kind) {
    case 'review_not_found':
      logger.warn(`Review ${review_id} not found`);
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
      logger.log(`Response already exists for review ${review_id} v${version}, completing outbox`);
      await maybeEnqueueFirstResponseDrafted({
        accountId: loaded.existing.accountId,
        businessId: loaded.existing.businessId,
        responseId: loaded.existing.id,
        reviewId: review_id,
        logger,
      });
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
  }

  const { ctx } = loaded;

  // ── Generate draft (cost-guard → generate → avoid-facts guardrail) ───
  // Retryable errors (concurrency / transient LLM) throw out of generateDraft
  // and propagate to BullMQ for retry. Permanent failures return { kind: 'failed' }.
  const draft = await generateDraft(ctx, { reviewId: review_id, version, businessId }, logger);
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
    reviewId: review_id,
    businessId,
    version,
    correlationId: job.data.correlation_id,
    suppressNotification: job.data.suppress_notification === true,
    moderation,
    accountId: ctx.accountId,
  });

  await maybeEnqueueFirstResponseDrafted({
    accountId: ctx.accountId,
    businessId,
    responseId,
    reviewId: review_id,
    logger,
  });

  // ── Complete outbox ──────────────────────────────────────────────────
  await markOutboxCompleted(outboxId, outboxAttempt);
  logger.log(`Response ${responseId} generated for review ${review_id} (v${version})`);
}
