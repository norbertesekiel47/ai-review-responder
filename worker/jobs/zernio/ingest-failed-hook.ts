import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../../src/lib/db/server';
import { extractOutboxHandle, markOutboxFailed } from '../../../src/lib/shared/outbox';
import {
  ZernioIngestReviewNotFoundError,
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
