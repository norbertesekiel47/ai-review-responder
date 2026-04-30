import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { sql, jsonb } from '@/lib/db/server';
import type { MonitoredReview } from './types';
import type {
  GenerateResponsePayload,
  NotifyAdminExceptionPayload,
} from '@/lib/shared/worker-types';

// ── Types ────────────────────────────────────────────────────────────

export type ProcessResult = 'new' | 'updated' | 'unchanged';

type TxClient = postgres.TransactionSql;

// ── Per-review processing ────────────────────────────────────────────
// Pure domain logic: dedup by provider identity, content-hash comparison,
// state-machine branching. Zero coupling to BullMQ. Operates on a
// Postgres.js transaction.

export async function processReview(
  monitored: MonitoredReview,
  businessId: string,
  correlationId?: string,
  options?: { suppressNotification?: boolean },
): Promise<ProcessResult> {
  const suppressNotification = options?.suppressNotification ?? false;
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
      // ── NEW review — insert with ON CONFLICT guard for concurrent writers ──
      const reviewId = uuidv7();

      const inserted = await tx<{ id: string }[]>`
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
        ON CONFLICT (provider, provider_review_name) DO NOTHING
        RETURNING id
      `;

      if (inserted.count > 0) {
        // We won the race — enqueue response generation
        const outboxPayload: GenerateResponsePayload = {
          review_id: reviewId,
          business_id: businessId,
          version: 1,
          correlation_id: correlationId,
          suppress_notification: suppressNotification,
        };

        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()}, 'generate_response', 'review', ${reviewId},
            ${jsonb(outboxPayload)}, 'pending'
          )
        `;

        return 'new' as const;
      }

      // We lost the race — another concurrent writer inserted this review first.
      // Re-read the winner row with FOR UPDATE and fall through to existing-row logic.
      const [winner] = await tx<{
        id: string;
        review_content_hash: string | null;
      }[]>`
        SELECT id, review_content_hash
        FROM reviews
        WHERE provider = ${identity.provider}
          AND provider_review_name = ${identity.providerReviewName}
        FOR UPDATE
      `;

      if (!winner) {
        throw new Error(
          `process-review: race-loss without winner row for ${identity.providerReviewName}`,
        );
      }

      return processExistingReview(
        tx,
        winner,
        monitored,
        businessId,
        correlationId,
        suppressNotification,
      );
    }

    return processExistingReview(
      tx,
      existing,
      monitored,
      businessId,
      correlationId,
      suppressNotification,
    );
  });
}

// ── Existing-row state machine ────────────────────────────────────────
// Called both from the normal path (existing row found on first SELECT)
// and from the race-loss path (winner row found after INSERT DO NOTHING).

async function processExistingReview(
  tx: TxClient,
  existing: { id: string; review_content_hash: string | null },
  monitored: MonitoredReview,
  businessId: string,
  correlationId: string | undefined,
  suppressNotification: boolean,
): Promise<ProcessResult> {
  const { review, contentHash } = monitored;
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

  // Find the current non-terminal response for this review. FOR UPDATE
  // serializes against a concurrent approval transaction (which also
  // SELECTs the row FOR UPDATE in src/lib/approval/service.ts) so we
  // can't re-read a stale status and then stomp a fresh approval with
  // status='failed' below.
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
    FOR UPDATE
  `;

  if (!activeResponse) {
    // No active response — queue a fresh generation. Use MAX(version)+1
    // so a prior terminal v1 (e.g. failed by cost-limit) doesn't collide
    // with the new draft. ResponseGeneratorWorker's idempotency check
    // (UNIQUE (review_id, version)) would otherwise short-circuit on the
    // existing terminal row and silently skip generation.
    const [versionRow] = await tx<{ next_version: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS next_version
      FROM responses
      WHERE review_id = ${existing.id}
    `;
    const nextVersion = versionRow?.next_version ?? 1;

    const outboxPayload: GenerateResponsePayload = {
      review_id: existing.id,
      business_id: businessId,
      version: nextVersion,
      correlation_id: correlationId,
      suppress_notification: suppressNotification,
    };

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'generate_response', 'review', ${existing.id},
        ${jsonb(outboxPayload)}, 'pending'
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
      correlation_id: correlationId,
      suppress_notification: suppressNotification,
    };

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()}, 'generate_response', 'review', ${existing.id},
        ${jsonb(outboxPayload)}, 'pending'
      )
    `;

    return 'updated' as const;
  }

  if (
    activeResponse.status === 'posted' ||
    activeResponse.status === 'awaiting_owner_connect'
  ) {
    // Already posted/pending post — create review_exception + notify admin.
    // `awaiting_owner_connect` is included so an owner-approved response
    // queued for Zernio publish isn't silently discarded if the customer
    // edits their review while the owner is still reconnecting.
    const exceptionId = uuidv7();

    const inserted = await tx`
      INSERT INTO review_exceptions (id, business_id, review_id, response_id, type, status, payload)
      VALUES (
        ${exceptionId}, ${businessId}, ${existing.id}, ${activeResponse.id},
        'review_edited_after_post', 'open',
        ${jsonb({
          old_content_hash: existingHash,
          new_content_hash: contentHash,
          response_status: activeResponse.status,
        })}
      )
      ON CONFLICT (review_id, type) WHERE status = 'open'
      DO NOTHING
    `;

    if (inserted.count > 0) {
      const notifyPayload: NotifyAdminExceptionPayload = {
        review_exception_id: exceptionId,
        business_id: businessId,
        correlation_id: correlationId,
      };

      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()}, 'notify_admin_review_exception', 'review', ${existing.id},
          ${jsonb(notifyPayload)}, 'pending'
        )
      `;
    }

    // Supersede the parked response so DrainOwnerConnectWorker doesn't
    // re-queue a stale response when the owner reconnects. 'posted' responses
    // are NOT superseded — that's truly terminal (the reply already exists on
    // Google; no further action is possible from our side).
    if (activeResponse.status === 'awaiting_owner_connect') {
      await tx`
        UPDATE responses
        SET status = 'superseded',
            posting_error = 'review_content_changed_during_park',
            updated_at = NOW()
        WHERE id = ${activeResponse.id}
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
    correlation_id: correlationId,
    suppress_notification: suppressNotification,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${uuidv7()}, 'generate_response', 'review', ${existing.id},
      ${jsonb(outboxPayload)}, 'pending'
    )
  `;

  return 'updated' as const;
}

// ── ROI baseline capture ────────────────────────────────────────────

const LOG_PREFIX = '[process-review]';

export async function captureRoiBaseline(businessId: string): Promise<void> {
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

// ── Helpers ─────────────────────────────────────────────────────────

export function isPermanentSerpApiError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('401') || lower.includes('403') || lower.includes('quota');
}
