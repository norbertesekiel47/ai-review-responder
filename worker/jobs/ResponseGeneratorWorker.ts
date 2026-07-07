import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
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
  const loaded = await loadGenerationContext(sql, { reviewId, businessId, version });
  switch (loaded.kind) {
    case 'review_not_found':
      logger.warn(`Review ${reviewId} not found`);
      await markOutboxFailed(sql, outboxId, 'review_not_found', outboxAttempt);
      return;
    case 'business_not_found':
      logger.warn(`Business ${businessId} not found`);
      await markOutboxFailed(sql, outboxId, 'business_not_found', outboxAttempt);
      return;
    case 'skipped':
      // Object arg so `reason` (archived_location, subscription-guard
      // reasons, account_offboarding_blocked) is queryable in the structured
      // log record (string args are logged verbatim, not as fields).
      logger.log('skipping generation', { reason: loaded.reason, business_id: businessId });
      await markOutboxCompleted(sql, outboxId, outboxAttempt);
      return;
    case 'already_exists':
      logger.log(`Response already exists for review ${reviewId} v${version}, completing outbox`);
      if (loaded.processingBlocked) {
        // No durable analytics write for an account in active offboarding —
        // the dispatch poller has no offboarding gate and would export the
        // event (with live identifiers) for an account mid-purge.
        logger.log('suppressing first_response_drafted enqueue', {
          reason: 'account_offboarding_blocked',
          business_id: businessId,
        });
      } else {
        await maybeEnqueueFirstResponseDrafted(sql, {
          accountId: loaded.existing.accountId,
          businessId: loaded.existing.businessId,
          responseId: loaded.existing.id,
          reviewId,
          logger,
        });
      }
      await markOutboxCompleted(sql, outboxId, outboxAttempt);
      return;
  }

  const { ctx } = loaded;

  // ── Generate draft (cost-guard → generate → avoid-facts guardrail) ───
  // Retryable errors (concurrency / transient LLM) throw out of generateDraft
  // and propagate to BullMQ for retry. Permanent failures return { kind: 'failed' }.
  const draft = await generateDraft(sql, ctx, { reviewId, version, businessId }, logger);
  if (draft.kind === 'failed') {
    await markOutboxFailed(sql, outboxId, draft.reason, outboxAttempt);
    return;
  }

  // ── Output moderation (local rules always; provider if configured) ───
  const moderation = await moderateResponse(draft.result.responseText);

  // ── Persist response + outbox + cost link + moderation hold in one tx ─
  // (invariant #4: a high-severity flag holds the draft + skips notification,
  // atomically with response persistence). DB failure throws → BullMQ retry.
  const responseId = await persistResponseAndNotify(sql, {
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

  await maybeEnqueueFirstResponseDrafted(sql, {
    accountId: ctx.accountId,
    businessId,
    responseId,
    reviewId,
    logger,
  });

  // ── Complete outbox ──────────────────────────────────────────────────
  await markOutboxCompleted(sql, outboxId, outboxAttempt);
  logger.log(`Response ${responseId} generated for review ${reviewId} (v${version})`);
}
