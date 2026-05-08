import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import type { ValidatePlaceIdPayload } from '../../src/lib/shared/worker-types';
import { parseGoogleMapsUrl, isPlaceId } from '../../src/lib/reviews/url-parser';
import { resolvePlaceId } from '../../src/lib/reviews/place-id-resolver';
import { ExceptionType } from '../../src/lib/shared/constants';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { asLocationId } from '../../src/lib/shared/ids';
import type { LocationId } from '../../src/lib/shared/ids';

export async function handlePlaceIdValidation(
  job: Job<ValidatePlaceIdPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[PlaceIdValidationWorker]', job.data.correlation_id);
  const { google_maps_url } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Load business
  const [business] = await sql<{ id: string; google_place_id: string | null }[]>`
    SELECT id, google_place_id FROM businesses WHERE id = ${businessId}
  `;

  if (!business) {
    logger.warn(`Business ${businessId} not found`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Parse URL for all available data
  const urlData = parseGoogleMapsUrl(google_maps_url);

  // If URL contained a canonical Place ID, verify format and store.
  // Review ingestion is now webhook-driven via Zernio — no sync_reviews enqueue.
  if (urlData.placeId && isPlaceId(urlData.placeId)) {
    await sql`
      UPDATE businesses
      SET google_place_id = ${urlData.placeId},
          place_id_verified = TRUE
      WHERE id = ${businessId}
    `;

    await markOutboxCompleted(outboxId, outboxAttempt);
    logger.log(`Business ${businessId} verified (canonical ID in URL)`);
    return;
  }

  // Otherwise, resolve via SerpAPI search
  try {
    const resolvedPlaceId = await resolvePlaceId(urlData);

    await sql`
      UPDATE businesses
      SET google_place_id = ${resolvedPlaceId},
          place_id_verified = TRUE
      WHERE id = ${businessId}
    `;

    await markOutboxCompleted(outboxId, outboxAttempt);
    logger.log(`Business ${businessId} resolved to ${resolvedPlaceId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Transient errors (SerpAPI down) → throw for BullMQ retry
    if (message.includes('SerpAPI search error')) {
      logger.error(`Transient error for ${businessId}: ${message}`);
      throw error;
    }

    // Permanent errors (no match, rate limit, bad data) → fail outbox + log exception
    logger.error(`Permanent resolution failure for ${businessId}: ${message}`);

    await sql`
      INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${businessId}, NULL, ${ExceptionType.PLACE_ID_RESOLUTION_FAILED}, 'open',
        ${jsonb({ reason: message, google_maps_url })}
      )
    `;

    await markOutboxFailed(outboxId, message, outboxAttempt);
  }
}

