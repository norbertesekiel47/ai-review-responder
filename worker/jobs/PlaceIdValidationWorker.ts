import type { Job } from 'bullmq';
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import type { ValidatePlaceIdPayload, SyncReviewsPayload } from '../../src/lib/shared/worker-types';
import { parseGoogleMapsUrl, isPlaceId } from '../../src/lib/reviews/url-parser';
import { resolvePlaceId } from '../../src/lib/reviews/place-id-resolver';
import { ExceptionType } from '../../src/lib/shared/constants';
import { createWorkerLogger } from '../../src/lib/shared/logger';

type TxClient = postgres.TransactionSql;

export async function handlePlaceIdValidation(
  job: Job<ValidatePlaceIdPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[PlaceIdValidationWorker]', job.data.correlation_id);
  const { business_id, google_maps_url } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // Load business
  const [business] = await sql<{ id: string; google_place_id: string | null }[]>`
    SELECT id, google_place_id FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    logger.warn(`Business ${business_id} not found`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Parse URL for all available data
  const urlData = parseGoogleMapsUrl(google_maps_url);

  // If URL contained a canonical Place ID, verify format and store
  if (urlData.placeId && isPlaceId(urlData.placeId)) {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE businesses
        SET google_place_id = ${urlData.placeId},
            place_id_verified = TRUE
        WHERE id = ${business_id}
      `;

      await enqueueSyncReviews(tx, business_id, urlData.placeId!, job.data.correlation_id);
    });

    await markOutboxCompleted(outboxId);
    logger.log(`Business ${business_id} verified (canonical ID in URL)`);
    return;
  }

  // Otherwise, resolve via SerpAPI search
  try {
    const resolvedPlaceId = await resolvePlaceId(urlData);

    await sql.begin(async (tx) => {
      await tx`
        UPDATE businesses
        SET google_place_id = ${resolvedPlaceId},
            place_id_verified = TRUE
        WHERE id = ${business_id}
      `;

      await enqueueSyncReviews(tx, business_id, resolvedPlaceId, job.data.correlation_id);
    });

    await markOutboxCompleted(outboxId);
    logger.log(`Business ${business_id} resolved to ${resolvedPlaceId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Transient errors (SerpAPI down) → throw for BullMQ retry
    if (message.includes('SerpAPI search error')) {
      logger.error(`Transient error for ${business_id}: ${message}`);
      throw error;
    }

    // Permanent errors (no match, rate limit, bad data) → fail outbox + log exception
    logger.error(`Permanent resolution failure for ${business_id}: ${message}`);

    await sql`
      INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${business_id}, NULL, ${ExceptionType.PLACE_ID_RESOLUTION_FAILED}, 'open',
        ${jsonb({ reason: message, google_maps_url })}
      )
    `;

    await markOutboxFailed(outboxId, message);
  }
}

/** Enqueue sync_reviews with WHERE NOT EXISTS dedup guard (same pattern as ReconciliationPoller). */
async function enqueueSyncReviews(
  tx: TxClient,
  businessId: string,
  placeId: string,
  correlationId?: string,
): Promise<void> {
  const syncPayload: SyncReviewsPayload = {
    business_id: businessId,
    google_place_id: placeId,
    correlation_id: correlationId,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      ${uuidv7()},
      'sync_reviews',
      'business',
      ${businessId},
      ${jsonb(syncPayload)},
      'pending'
    WHERE NOT EXISTS (
      SELECT 1 FROM job_outbox jo
      WHERE jo.topic = 'sync_reviews'
        AND jo.aggregate_id = ${businessId}
        AND jo.status IN ('pending', 'dispatching', 'dispatched')
    )
  `;
}
