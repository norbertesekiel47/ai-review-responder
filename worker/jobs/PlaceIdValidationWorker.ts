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

type ApplyPlaceIdOutcome = 'applied' | 'duplicate' | 'mismatch';

/**
 * Writes the resolved place id + place_id_verified=TRUE for a business.
 *
 * Outcomes:
 *  - 'applied'   — the UPDATE committed.
 *  - 'duplicate' — tripped businesses_account_place_uniq (migration 062): the
 *    resolved id already belongs to another ACTIVE location in the account.
 *  - 'mismatch'  — the row already holds a DIFFERENT canonical place id; the
 *    WHERE guard matched 0 rows. Resolution must never silently overwrite an
 *    explicitly stored CANONICAL id (defense for any producer that enqueues
 *    alongside a stored id — current routes prevent that shape, queued legacy
 *    jobs may not).
 *
 * A stored NON-canonical identifier (hex CID `0x...:0x...` — the tentative
 * value the URL-mode onboarding paths extract before resolution) IS
 * overwritable by the resolved canonical id; without that self-heal those
 * locations would resolve to 'mismatch' and stay permanently unverified.
 * Race-safe: the guard only overwrites the exact non-canonical value loaded
 * at job start, so a concurrent write of a canonical id still mismatches.
 *
 * In the non-applied cases the row is untouched and the caller
 * skips-as-success. Any other error propagates unchanged so the worker's
 * existing transient/permanent handling still applies.
 */
async function applyResolvedPlaceId(
  businessId: LocationId,
  resolvedPlaceId: string,
  storedPlaceId: string | null,
): Promise<ApplyPlaceIdOutcome> {
  const overwritableStoredId =
    storedPlaceId !== null && !isPlaceId(storedPlaceId) ? storedPlaceId : null;
  try {
    const rows = await sql`
      UPDATE businesses
      SET google_place_id = ${resolvedPlaceId},
          place_id_verified = TRUE
      WHERE id = ${businessId}
        AND (google_place_id IS NULL
          OR google_place_id = ${resolvedPlaceId}
          OR google_place_id = ${overwritableStoredId})
      RETURNING id
    `;
    return rows.length > 0 ? 'applied' : 'mismatch';
  } catch (err) {
    if (isDuplicateLocationViolation(err)) return 'duplicate';
    throw err;
  }
}

/**
 * Durable record for a non-applied resolution (duplicate or mismatch). The
 * skip itself is skip-as-success (outbox completes, no retry — the location
 * stays active and unverified by design), but WITHOUT a row here the dead
 * state is undiagnosable once the log line rotates: the owner's location
 * silently never ingests reviews. Mirrors the permanent-failure path's
 * review_exceptions insert so support/admin tooling surfaces it.
 */
async function recordSkippedResolutionException(
  businessId: string,
  reason: string,
  googleMapsUrl: string,
  resolvedPlaceId: string,
): Promise<void> {
  await sql`
    INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${businessId}, NULL, ${ExceptionType.PLACE_ID_RESOLUTION_FAILED}, 'open',
      ${jsonb({ reason, google_maps_url: googleMapsUrl, resolved_place_id: resolvedPlaceId })}
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
  storedPlaceId: string | null;
  outboxId: string;
  outboxAttempt: number | undefined;
}): Promise<ApplyPlaceIdOutcome> {
  const outcome = await applyResolvedPlaceId(input.businessId, input.placeId, input.storedPlaceId);
  if (outcome !== 'applied') {
    await recordSkippedResolutionException(
      input.businessId,
      skipReason(outcome),
      input.googleMapsUrl,
      input.placeId,
    );
  }
  await markOutboxCompleted(input.outboxId, input.outboxAttempt);
  return outcome;
}

/** Log/exception reason for a non-applied resolution outcome. */
function skipReason(outcome: ApplyPlaceIdOutcome): string {
  return outcome === 'duplicate' ? DUPLICATE_LOCATION : 'place_id_mismatch';
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
    const outcome = await applyPlaceIdAndFinalize({
      businessId,
      googleMapsUrl: google_maps_url,
      placeId: urlData.placeId,
      storedPlaceId: business.google_place_id,
      outboxId,
      outboxAttempt,
    });
    if (outcome === 'applied') {
      logger.log(`Business ${businessId} verified (canonical ID in URL)`);
    } else {
      logger.log(
        `Business ${businessId} canonical place_id not applied — leaving unverified`,
        { reason: skipReason(outcome) },
      );
    }
    return;
  }

  // Otherwise, resolve via SerpAPI search
  try {
    const resolvedPlaceId = await resolvePlaceId(urlData);

    const outcome = await applyPlaceIdAndFinalize({
      businessId,
      googleMapsUrl: google_maps_url,
      placeId: resolvedPlaceId,
      storedPlaceId: business.google_place_id,
      outboxId,
      outboxAttempt,
    });
    if (outcome === 'applied') {
      logger.log(`Business ${businessId} resolved to ${resolvedPlaceId}`);
    } else {
      logger.log(
        `Business ${businessId} resolved place_id not applied — leaving unverified`,
        { reason: skipReason(outcome) },
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

