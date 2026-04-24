import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { getReviewMonitor } from '../../src/lib/shared/mock-mode';
import type { SyncReviewsPayload } from '../../src/lib/shared/worker-types';
import {
  processReview,
  captureRoiBaseline,
  isPermanentSerpApiError,
} from '../../src/lib/reviews/process-review';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handleReviewSync(
  job: Job<SyncReviewsPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ReviewSyncWorker]', job.data.correlation_id);
  const { business_id, google_place_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── Step 1: Load business and validate ──────────────────────────────
  const [business] = await sql<{
    id: string;
    subscription_status: string;
    google_place_id: string | null;
    place_id_verified: boolean;
    baseline_captured_at: Date | null;
    updated_at: Date;
  }[]>`
    SELECT id, subscription_status, google_place_id, place_id_verified, baseline_captured_at, updated_at
    FROM businesses
    WHERE id = ${business_id}
  `;

  if (!business) {
    logger.warn(`Business ${business_id} not found`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  if (!business.google_place_id) {
    logger.warn(`Business ${business_id} has no google_place_id`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  if (!business.place_id_verified) {
    logger.warn(`Business ${business_id} place_id not verified, skipping`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'generator',
  );

  if (!subCheck.allowed) {
    logger.warn(`Business ${business_id} subscription blocked: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 2: Fetch reviews ───────────────────────────────────────────
  const monitor = getReviewMonitor(process.env.SERPAPI_API_KEY ?? '');

  let fetchResult;
  try {
    fetchResult = await monitor.fetchReviews(business.google_place_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (isPermanentSerpApiError(message)) {
      logger.error(`Permanent SerpAPI error for business ${business_id}: ${message}`);
      await markOutboxFailed(outboxId, `serpapi_permanent: ${message}`, outboxAttempt);
      return;
    }

    // Transient error — throw so BullMQ retries with backoff
    logger.error(`Transient SerpAPI error for business ${business_id}: ${message}`);
    throw error;
  }

  const { reviews, collisions } = fetchResult;

  // ── Step 3: Store identity collisions in review_exceptions ──────────
  for (const collision of collisions) {
    logger.warn(
      `Identity collision for business ${business_id}: ` +
        `providerReviewId=${collision.identity.providerReviewId} ` +
        `strategy=${collision.identity.identityStrategy}`,
    );

    try {
      await sql`
        INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload)
        VALUES (
          ${uuidv7()}, ${business_id}, NULL, 'identity_collision', 'open',
          ${jsonb({
            provider_review_id: collision.identity.providerReviewId,
            identity_strategy: collision.identity.identityStrategy,
            content_hash: collision.contentHash,
            collides_with_content_hash: collision.collidesWithContentHash,
            reviewer_name: collision.review.reviewerName,
            review_date: collision.review.reviewDate,
          })}
        )
        ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
          WHERE status = 'open' AND review_id IS NULL
        DO NOTHING
      `;
    } catch (err) {
      logger.error(`Failed to store identity collision: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Step 4: Process each review in its own transaction ──────────────
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let errorCount = 0;

  for (const monitored of reviews) {
    try {
      const result = await processReview(monitored, business_id, job.data.correlation_id);

      switch (result) {
        case 'new':
          newCount++;
          break;
        case 'updated':
          updatedCount++;
          break;
        case 'unchanged':
          unchangedCount++;
          break;
      }
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `Error processing review ${monitored.identity.providerReviewId} ` +
          `for business ${business_id}: ${message}`,
      );
    }
  }

  logger.log(
    `Business ${business_id}: ` +
      `new=${newCount} updated=${updatedCount} unchanged=${unchangedCount} errors=${errorCount} ` +
      `collisions=${collisions.length}`,
  );

  // ── Step 5: Update last_sync_at ─────────────────────────────────────
  await sql`
    UPDATE businesses
    SET last_sync_at = NOW()
    WHERE id = ${business_id}
  `;

  // ── Step 6: ROI baseline capture on first sync ──────────────────────
  if (!business.baseline_captured_at) {
    await captureRoiBaseline(business_id);
  }

  // ── Step 7: Complete outbox ─────────────────────────────────────────
  await markOutboxCompleted(outboxId, outboxAttempt);
}
