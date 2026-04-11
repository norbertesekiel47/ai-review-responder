import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { getReviewMonitor } from '../../src/lib/shared/mock-mode';
import type {
  SyncReviewsPayload,
  GenerateResponsePayload,
  NotifyAdminExceptionPayload,
} from '../../src/lib/shared/worker-types';
import type { MonitoredReview } from '../../src/lib/reviews/types';

const LOG_PREFIX = '[ReviewSyncWorker]';

export async function handleReviewSync(
  job: Job<SyncReviewsPayload>,
): Promise<void> {
  const { business_id, google_place_id } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // ── Step 1: Load business and validate ──────────────────────────────
  const [business] = await sql<{
    id: string;
    subscription_status: string;
    google_place_id: string | null;
    baseline_captured_at: Date | null;
    updated_at: Date;
  }[]>`
    SELECT id, subscription_status, google_place_id, baseline_captured_at, updated_at
    FROM businesses
    WHERE id = ${business_id}
  `;

  if (!business) {
    console.warn(`${LOG_PREFIX} Business ${business_id} not found`);
    await markOutboxCompleted(outboxId);
    return;
  }

  if (!business.google_place_id) {
    console.warn(`${LOG_PREFIX} Business ${business_id} has no google_place_id`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'generator',
  );

  if (!subCheck.allowed) {
    console.warn(`${LOG_PREFIX} Business ${business_id} subscription blocked: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
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
      console.error(`${LOG_PREFIX} Permanent SerpAPI error for business ${business_id}: ${message}`);
      await markOutboxFailed(outboxId, `serpapi_permanent: ${message}`);
      return;
    }

    // Transient error — throw so BullMQ retries with backoff
    console.error(`${LOG_PREFIX} Transient SerpAPI error for business ${business_id}: ${message}`);
    throw error;
  }

  const { reviews, collisions } = fetchResult;

  // ── Step 3: Store identity collisions in review_exceptions ──────────
  // review_id is NULL because collisions are detected pre-insert (the
  // review hasn't been created yet). Migration 005 makes review_id nullable.
  for (const collision of collisions) {
    console.warn(
      `${LOG_PREFIX} Identity collision for business ${business_id}: ` +
        `providerReviewId=${collision.identity.providerReviewId} ` +
        `strategy=${collision.identity.identityStrategy}`,
    );

    try {
      // idx_review_exceptions_collision_dedup enforces at most one open
      // identity_collision per (business_id, type, payload->>'provider_review_id').
      // ON CONFLICT DO NOTHING handles both same-worker repeats and concurrent workers.
      await sql`
        INSERT INTO review_exceptions (id, business_id, review_id, type, status, payload)
        VALUES (
          ${uuidv7()}, ${business_id}, NULL, 'identity_collision', 'open',
          ${JSON.stringify({
            provider_review_id: collision.identity.providerReviewId,
            identity_strategy: collision.identity.identityStrategy,
            content_hash: collision.contentHash,
            collides_with_content_hash: collision.collidesWithContentHash,
            reviewer_name: collision.review.reviewerName,
            review_date: collision.review.reviewDate,
          })}::jsonb
        )
        ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
          WHERE status = 'open' AND review_id IS NULL
        DO NOTHING
      `;
    } catch (err) {
      // Non-fatal — log and continue
      console.error(`${LOG_PREFIX} Failed to store identity collision: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Step 4: Process each review in its own transaction ──────────────
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let errorCount = 0;

  for (const monitored of reviews) {
    try {
      const result = await processReview(monitored, business_id);

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
      console.error(
        `${LOG_PREFIX} Error processing review ${monitored.identity.providerReviewId} ` +
          `for business ${business_id}: ${message}`,
      );
    }
  }

  console.log(
    `${LOG_PREFIX} Business ${business_id}: ` +
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
  await markOutboxCompleted(outboxId);
}

// ── Per-review processing ───────────────────────────────────────────────

type ProcessResult = 'new' | 'updated' | 'unchanged';

async function processReview(
  monitored: MonitoredReview,
  businessId: string,
): Promise<ProcessResult> {
  const { review, identity, contentHash } = monitored;

  return await sql.begin(async (tx) => {
    // Try to lock existing review by provider identity (unique constraint)
    const [existing] = await tx<{
      id: string;
      review_content_hash: string | null;
    }[]>`
      SELECT id, review_content_hash
      FROM reviews
      WHERE provider = ${identity.provider}
        AND provider_review_name = ${identity.providerReviewName}
      FOR UPDATE
    `;

    if (!existing) {
      // ── NEW review ────────────────────────────────────────────────
      const reviewId = uuidv7();

      await tx`
        INSERT INTO reviews (
          id, business_id, provider, provider_review_id,
          provider_review_name, provider_location_name,
          reviewer_name, star_rating, review_text, review_date,
          detected_language, review_content_hash, status, detected_at
        ) VALUES (
          ${reviewId}, ${businessId}, ${identity.provider}, ${identity.providerReviewId},
          ${identity.providerReviewName}, ${identity.providerLocationName},
          ${review.reviewerName}, ${review.starRating}, ${review.reviewText}, ${review.reviewDate},
          ${review.detectedLanguage}, ${contentHash}, 'new', NOW()
        )
      `;

      const outboxPayload: GenerateResponsePayload = {
        review_id: reviewId,
        business_id: businessId,
        version: 1,
      };

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()}, 'generate_response', 'review', ${reviewId},
          ${JSON.stringify(outboxPayload)}::jsonb, 'pending'
        )
      `;

      return 'new' as const;
    }

    // ── EXISTING review — check content hash ──────────────────────
    const existingHash = existing.review_content_hash;

    if (existingHash === contentHash) {
      return 'unchanged' as const;
    }

    // ── CONTENT CHANGED — update the review row ───────────────────
    await tx`
      UPDATE reviews
      SET reviewer_name = ${review.reviewerName},
          star_rating = ${review.starRating},
          review_text = ${review.reviewText},
          review_date = ${review.reviewDate},
          detected_language = ${review.detectedLanguage},
          review_content_hash = ${contentHash}
      WHERE id = ${existing.id}
    `;

    // Find the current non-terminal response for this review
    const [activeResponse] = await tx<{
      id: string;
      status: string;
      version: number;
    }[]>`
      SELECT id, status, version
      FROM responses
      WHERE review_id = ${existing.id}
        AND status NOT IN ('superseded', 'failed')
      ORDER BY version DESC
      LIMIT 1
    `;

    if (!activeResponse) {
      // No active response — queue a fresh generation
      const outboxPayload: GenerateResponsePayload = {
        review_id: existing.id,
        business_id: businessId,
        version: 1,
      };

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()}, 'generate_response', 'review', ${existing.id},
          ${JSON.stringify(outboxPayload)}::jsonb, 'pending'
        )
      `;

      return 'updated' as const;
    }

    if (activeResponse.status === 'pending_approval') {
      // Pending approval — fail the old response, generate a new one
      await tx`
        UPDATE responses
        SET status = 'failed', posting_error = 'review_content_changed', updated_at = NOW()
        WHERE id = ${activeResponse.id}
      `;

      const nextVersion = activeResponse.version + 1;
      const outboxPayload: GenerateResponsePayload = {
        review_id: existing.id,
        business_id: businessId,
        version: nextVersion,
      };

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()}, 'generate_response', 'review', ${existing.id},
          ${JSON.stringify(outboxPayload)}::jsonb, 'pending'
        )
      `;

      return 'updated' as const;
    }

    if (
      activeResponse.status === 'posted' ||
      activeResponse.status === 'awaiting_manual_post'
    ) {
      // Already posted/pending post — create review_exception + notify admin.
      // ON CONFLICT DO NOTHING means if an open exception already exists for
      // this (review_id, type), the insert is silently skipped. Only queue
      // the notification if the exception was actually inserted.
      const exceptionId = uuidv7();

      const inserted = await tx`
        INSERT INTO review_exceptions (id, business_id, review_id, response_id, type, status, payload)
        VALUES (
          ${exceptionId}, ${businessId}, ${existing.id}, ${activeResponse.id},
          'review_edited_after_post', 'open',
          ${JSON.stringify({
            old_content_hash: existingHash,
            new_content_hash: contentHash,
            response_status: activeResponse.status,
          })}::jsonb
        )
        ON CONFLICT (review_id, type) WHERE status = 'open'
        DO NOTHING
      `;

      if (inserted.count > 0) {
        const notifyPayload: NotifyAdminExceptionPayload = {
          review_exception_id: exceptionId,
          business_id: businessId,
        };

        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()}, 'notify_admin_review_exception', 'review', ${existing.id},
            ${JSON.stringify(notifyPayload)}::jsonb, 'pending'
          )
        `;
      }

      return 'updated' as const;
    }

    // Other statuses (approved, edited) — supersede and regenerate
    await tx`
      UPDATE responses
      SET status = 'superseded', updated_at = NOW()
      WHERE id = ${activeResponse.id}
    `;

    const nextVersion = activeResponse.version + 1;
    const outboxPayload: GenerateResponsePayload = {
      review_id: existing.id,
      business_id: businessId,
      version: nextVersion,
    };

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'generate_response', 'review', ${existing.id},
        ${JSON.stringify(outboxPayload)}::jsonb, 'pending'
      )
    `;

    return 'updated' as const;
  });
}

// ── ROI baseline capture ────────────────────────────────────────────────

async function captureRoiBaseline(businessId: string): Promise<void> {
  try {
    const [countRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM reviews WHERE business_id = ${businessId}
    `;
    const reviewCount = parseInt(countRow?.count ?? '0', 10);

    // SerpAPI does NOT reliably provide owner-reply counts.
    // Default initial_responded_count = 0. Accuracy improves when GBP API arrives.
    await sql`
      UPDATE businesses
      SET initial_review_count = ${reviewCount},
          initial_responded_count = 0,
          baseline_captured_at = NOW()
      WHERE id = ${businessId}
        AND baseline_captured_at IS NULL
    `;

    console.log(
      `${LOG_PREFIX} ROI baseline captured for business ${businessId}: ${reviewCount} reviews`,
    );
  } catch (error) {
    // Non-fatal — baseline can be retried on next sync
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Failed to capture ROI baseline for business ${businessId}: ${message}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isPermanentSerpApiError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('401') || lower.includes('403') || lower.includes('quota');
}
