import type { Job } from 'bullmq';
import type { DemoJobPayload } from '../../src/lib/demos/types';
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

  const claimResult = await claimDemo('prospect_demos', demoId, logger);

  if (claimResult === 'not_found' || claimResult === 'already_terminal') {
    await markOutboxCompleted(outboxId, outboxAttempt);
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

    const result = await generateDemo({
      placeId: googlePlaceId,
      businessName,
      category: category ?? null,
    });

    await completeDemo('prospect_demos', demoId, outboxId, outboxAttempt, {
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
    await failDemo(
      'prospect_demos',
      demoId,
      outboxId,
      outboxAttempt,
      error instanceof Error ? error : new Error(message),
    );
    // Do NOT re-throw — failure is fully handled in Postgres.
    // BullMQ job completes cleanly. The outbox entry is already marked failed.
  }
}
