import type { Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { extractOutboxHandle, markOutboxFailed } from '../../../src/lib/shared/outbox';
import {
  ZernioIngestReviewNotFoundError,
  ZernioIngestPaginationCapExhaustedError,
  ZernioIngestUnparseableLocationError,
} from './ZernioReviewIngestWorker';
import type { IngestZernioReviewPayload } from '../../../src/lib/shared/worker-types';

/**
 * Final-attempt exhaustion handler for ZernioReviewIngestWorker. Typed errors
 * from the worker (ZernioIngestReviewNotFoundError, ZernioIngestPaginationCapExhaustedError,
 * ZernioIngestUnparseableLocationError) escalate to review_exceptions after BullMQ retries
 * are exhausted; the admin notify is deliberately skipped for review_not_found (high-volume
 * during Zernio outages would spam admin email; ops watches the table).
 */
export async function handleIngestFailed(
  job: Job<IngestZernioReviewPayload> | undefined,
  err: unknown,
): Promise<void> {
  if (!job) return;
  if (job.attemptsMade < (job.opts.attempts ?? 5)) return; // not yet exhausted

  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  if (err instanceof ZernioIngestReviewNotFoundError) {
    await handleReviewNotFound(err, outboxId, outboxAttempt);
    return;
  }

  if (err instanceof ZernioIngestPaginationCapExhaustedError) {
    await handlePaginationCapExhausted(err, outboxId, outboxAttempt);
    return;
  }

  if (err instanceof ZernioIngestUnparseableLocationError) {
    await handleUnparseableLocation(err, outboxId, outboxAttempt);
    return;
  }

  // Anything else: bare markOutboxFailed (existing behavior).
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(outboxId, reason, outboxAttempt);
}

async function handleReviewNotFound(
  err: ZernioIngestReviewNotFoundError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql`
    INSERT INTO review_exceptions (id, business_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${err.businessId}, 'zernio_review_not_found', 'open',
      ${jsonb({
        provider: 'zernio',
        provider_review_id: err.zernioReviewId,
        zernio_account_id: err.zernioAccountId,
        zernio_location_id: err.zernioLocationId,
        pages_walked: err.pagesWalked,
        reviews_seen: err.reviewsSeen,
        retries_exhausted_at: new Date().toISOString(),
      })}
    )
    ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
      WHERE status = 'open' AND review_id IS NULL
    DO NOTHING
  `;
  await markOutboxFailed(outboxId, 'zernio_review_not_found_after_retries', outboxAttempt);
}

async function handlePaginationCapExhausted(
  err: ZernioIngestPaginationCapExhaustedError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql`
    INSERT INTO review_exceptions (id, business_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${err.businessId}, 'zernio_pagination_cap_exhausted', 'open',
      ${jsonb({
        provider: 'zernio',
        provider_review_id: err.zernioReviewId,
        zernio_account_id: err.zernioAccountId,
        zernio_location_id: err.zernioLocationId,
        cap: err.cap,
        // pages_walked == cap in the cap-exhausted branch (we walked
        // every page allowed); included alongside cap so ops can compare
        // payloads across exception types without special-casing.
        pages_walked: err.cap,
        reviews_seen: err.reviewsSeen,
        retries_exhausted_at: new Date().toISOString(),
      })}
    )
    ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
      WHERE status = 'open' AND review_id IS NULL
    DO NOTHING
  `;
  // Trend-only Sentry signal — admin notify is intentionally skipped
  // (potential high-volume), but ops needs visibility on cap-exhaustion
  // rate so the cap can be tuned via ZERNIO_INGEST_MAX_PAGES.
  Sentry.captureMessage('zernio_pagination_cap_exhausted', {
    level: 'warning',
    tags: {
      worker: 'ingest_zernio_review',
      kind: 'pagination_cap_exhausted',
    },
    extra: {
      business_id: err.businessId,
      zernio_account_id: err.zernioAccountId,
      zernio_location_id: err.zernioLocationId,
      zernio_review_id: err.zernioReviewId,
      cap: err.cap,
      reviews_seen: err.reviewsSeen,
    },
  });
  await markOutboxFailed(outboxId, 'zernio_pagination_cap_exhausted', outboxAttempt);
}

async function handleUnparseableLocation(
  err: ZernioIngestUnparseableLocationError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  const [exception] = await sql<{ id: string }[]>`
    INSERT INTO review_exceptions (id, business_id, type, status, payload)
    VALUES (
      ${uuidv7()}, ${err.businessId}, 'zernio_unparseable_review_name', 'open',
      ${jsonb({
        provider: 'zernio',
        provider_review_id: err.zernioReviewId,
        zernio_account_id: err.zernioAccountId,
        zernio_location_id: err.zernioLocationId,
        review_name_truncated: err.reviewName.slice(0, 500),
        retries_exhausted_at: new Date().toISOString(),
      })}
    )
    ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
      WHERE status = 'open' AND review_id IS NULL
    DO NOTHING
    RETURNING id
  `;

  if (exception) {
    // Unparseable shape DOES warrant admin notify — signals contract change.
    await sql`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
      VALUES (
        ${uuidv7()}, 'notify_admin_review_exception', 'business',
        ${err.businessId},
        ${jsonb({ review_exception_id: exception.id, business_id: err.businessId })},
        0, 5
      )
    `;
  }
  await markOutboxFailed(outboxId, 'zernio_unparseable_review_name', outboxAttempt);
}
