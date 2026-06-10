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
import { isDuplicateLocationViolation, DUPLICATE_LOCATION } from '../../src/lib/locations/duplicate-location';

/**
 * Writes the resolved place id + place_id_verified=TRUE for a business.
 *
 * Returns `true` when the UPDATE committed and `false` when it tripped
 * businesses_account_place_uniq (migration 062) — i.e. the resolved place id
 * already belongs to another ACTIVE location in the same account. In the
 * duplicate case the UPDATE rolled back, so the location stays unverified
 * (correct) and the caller skips-as-success. Any non-duplicate error
 * propagates unchanged so the worker's existing transient/permanent handling
 * still applies.
 */
async function applyResolvedPlaceId(
  businessId: LocationId,
  resolvedPlaceId: string,
): Promise<boolean> {
  try {
    await sql`
      UPDATE businesses
      SET google_place_id = ${resolvedPlaceId},
          place_id_verified = TRUE
      WHERE id = ${businessId}
    `;
    return true;
  } catch (err) {
    if (isDuplicateLocationViolation(err)) return false;
    throw err;
  }
}

/**
 * Durable record for the duplicate-skip path. The skip itself is
 * skip-as-success (outbox completes, no retry — the location stays active
 * and unverified by design), but WITHOUT a row here the dead state is
 * undiagnosable once the log line rotates: the owner's location silently
 * never ingests reviews. Mirrors the permanent-failure path's
 * review_exceptions insert so support/admin tooling surfaces it.
 */
async function recordDuplicateLocationException(
  businessId: string,
  googleMapsUrl: string,
  duplicatePlaceId: string,
): Promise<void> {
  await sql`
    INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${businessId}, NULL, ${ExceptionType.PLACE_ID_RESOLUTION_FAILED}, 'open',
      ${jsonb({ reason: DUPLICATE_LOCATION, google_maps_url: googleMapsUrl, duplicate_place_id: duplicatePlaceId })}
    )
  `;
}

/**
 * Apply the resolved place id, record a durable exception if it duplicates an
 * active location, and complete the outbox (skip-as-success either way).
 * Returns whether the place id was applied; the caller owns logging.
 */
async function applyPlaceIdAndFinalize(input: {
  businessId: LocationId;
  googleMapsUrl: string;
  placeId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
}): Promise<boolean> {
  const applied = await applyResolvedPlaceId(input.businessId, input.placeId);
  if (!applied) {
    await recordDuplicateLocationException(input.businessId, input.googleMapsUrl, input.placeId);
  }
  await markOutboxCompleted(input.outboxId, input.outboxAttempt);
  return applied;
}

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
    const applied = await applyPlaceIdAndFinalize({
      businessId,
      googleMapsUrl: google_maps_url,
      placeId: urlData.placeId,
      outboxId,
      outboxAttempt,
    });
    if (applied) {
      logger.log(`Business ${businessId} verified (canonical ID in URL)`);
    } else {
      logger.log(
        `Business ${businessId} canonical place_id duplicates an active location — leaving unverified`,
        { reason: DUPLICATE_LOCATION },
      );
    }
    return;
  }

  // Otherwise, resolve via SerpAPI search
  try {
    const resolvedPlaceId = await resolvePlaceId(urlData);

    const applied = await applyPlaceIdAndFinalize({
      businessId,
      googleMapsUrl: google_maps_url,
      placeId: resolvedPlaceId,
      outboxId,
      outboxAttempt,
    });
    if (applied) {
      logger.log(`Business ${businessId} resolved to ${resolvedPlaceId}`);
    } else {
      logger.log(
        `Business ${businessId} resolved place_id duplicates an active location — leaving unverified`,
        { reason: DUPLICATE_LOCATION },
      );
    }
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

