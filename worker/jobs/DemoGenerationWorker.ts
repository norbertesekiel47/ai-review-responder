import type { Job } from 'bullmq';
import type { DemoJobPayload } from '../../src/lib/demos/types';
import { sql } from '../../src/lib/db/server';
import { generateDemo } from '../../src/lib/demos/generator';
import { claimDemo, completeDemo, failDemo } from '../../src/lib/demos/lifecycle';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '../../src/lib/shared/outbox';
import { isPlaceId, parseGoogleMapsUrl } from '../../src/lib/reviews/url-parser';
import { resolvePlaceId } from '../../src/lib/reviews/place-id-resolver';

export async function handleDemoGeneration(
  job: Job<DemoJobPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[DemoGenerationWorker]', job.data.correlation_id);
  const { demoId, businessName, category } = job.data;
  let { googlePlaceId } = job.data;
  const googleMapsUrl = job.data.googleMapsUrl;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const claimResult = await claimDemo(sql, 'prospect_demos', demoId, logger);

  if (
    claimResult === 'not_found' ||
    claimResult === 'already_terminal' ||
    claimResult === 'race_lost'
  ) {
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  if (claimResult === 'reset_to_queued') {
    // Per lifecycle.ts CALLER CONTRACT comment: throw so BullMQ re-dispatches.
    // The row is already reset to 'queued' so the next dispatch will reclaim it.
    throw new Error(`Demo ${demoId} reset from stale running; re-dispatching`);
  }

  // claimResult === 'claimed' — proceed.
  try {
    if (!isPlaceId(googlePlaceId) && googleMapsUrl) {
      const urlData = parseGoogleMapsUrl(googleMapsUrl);
      googlePlaceId = await resolvePlaceId(urlData);
    } else if (!isPlaceId(googlePlaceId)) {
      throw new Error('Invalid Place ID and no URL available for resolution');
    }

    const result = await generateDemo(sql, {
      placeId: googlePlaceId,
      businessName,
      category: category ?? null,
    });

    await completeDemo(sql, 'prospect_demos', demoId, outboxId, outboxAttempt, {
      reviews: result.reviews,
      responses: result.responses,
      // No `source` — prospect_demos has no `source` column (it has its own
      // `review_source` populated at INSERT time by the prospect-demo creation
      // path).
    });

    logger.log(
      `Demo ${demoId} completed: ${result.metadata.successfulResponses}/${result.metadata.totalReviews} responses in ${result.metadata.generationDurationMs}ms`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Demo ${demoId} failed: ${message}`);
    try {
      await failDemo(
        sql,
        'prospect_demos',
        demoId,
        outboxId,
        outboxAttempt,
        error instanceof Error ? error : new Error(message),
      );
    } catch (txError) {
      // failDemo's tx itself failed (e.g. DB transport flake). Distinguish
      // this from the original generation failure in logs so ops can tell
      // "the LLM failed" from "we couldn't even record that the LLM failed".
      // Re-throw so BullMQ retries — the idempotency check at the top of the
      // next attempt will catch up the lifecycle state.
      logger.error(
        `Failed to record failure for demo ${demoId}: ${txError instanceof Error ? txError.message : String(txError)}`,
      );
      throw txError;
    }
    // Do NOT re-throw the original `error` — failure is fully handled in
    // Postgres. BullMQ job completes cleanly. The outbox entry is marked failed.
  }
}
