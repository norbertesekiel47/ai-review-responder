import { v7 as uuidv7 } from 'uuid';
import { jsonb, sql } from '../../../src/lib/db/server';
import { getReviewPublisher } from '../../../src/lib/publishing/review-publisher';
import type { ResolvedPublishTarget } from '../../../src/lib/publishing/review-publisher';
import { markOutboxCompleted } from '../../../src/lib/shared/outbox';
import { PublisherTransientWithContext } from './publisher-error-handlers';
import { parkResponseForOwnerReconnect } from './no-connection';
import type { WorkerLogger } from '../../../src/lib/shared/logger';

/**
 * Resolve a response's publishing target through the ReviewPublisher seam and
 * disposition every non-success resolution outcome (the seam owns the provider
 * connection lookup + review-id resolution; this owns the worker-side DB writes):
 *   - no_connection   → park the response for owner reconnect (terminal here)
 *   - review_not_found → open a review_exception + admin notify (terminal here)
 *   - transient       → rethrow with attempt context so BullMQ retries
 * On success returns the ResolvedPublishTarget for the caller to publish.
 */
export async function resolvePublishTarget(input: {
  responseId: string;
  businessId: string;
  reviewId: string;
  responseStatus: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: WorkerLogger;
}): Promise<ResolvedPublishTarget | 'completed'> {
  const {
    responseId,
    businessId,
    reviewId,
    responseStatus,
    outboxId,
    outboxAttempt,
    logger,
  } = input;

  const resolution = await getReviewPublisher().resolveTarget({ responseId, reviewId, businessId });

  switch (resolution.kind) {
    case 'no_connection':
      await parkResponseForOwnerReconnect({
        responseId,
        businessId,
        outboxId,
        outboxAttempt,
        responseStatus,
        logger,
      });
      return 'completed';

    case 'review_not_found':
      await openReviewNotFoundException({
        responseId,
        businessId,
        reviewId,
        errorMeta: resolution.meta,
        outboxId,
        outboxAttempt,
        logger,
      });
      return 'completed';

    case 'transient':
      throw new PublisherTransientWithContext(resolution.error, {
        response_id: responseId,
        business_id: businessId,
        account_id: resolution.accountId,
        location_id: resolution.locationId,
      });

    case 'resolved':
      return resolution.target;
  }
}

/**
 * Terminal disposition for a review the provider could not match: fail the
 * response, open (idempotently) a `zernio_review_id_mismatch` review_exception,
 * and enqueue the admin notify — all in one tx, status-guarded so a row already
 * moved terminal by a parallel worker is left alone.
 */
async function openReviewNotFoundException(input: {
  responseId: string;
  businessId: string;
  reviewId: string;
  errorMeta: Record<string, unknown>;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: WorkerLogger;
}): Promise<void> {
  const { responseId, businessId, reviewId, errorMeta, outboxId, outboxAttempt, logger } = input;

  const openedException = await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE responses
      SET status = 'failed', updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;

    if (updated.count === 0) {
      logger.log(
        `Response ${responseId} already terminal, skipping zernio_review_id_mismatch exception`,
      );
      return false;
    }

    const [exception] = await tx<{ id: string }[]>`
      INSERT INTO review_exceptions (
        id, business_id, review_id, response_id, type, payload
      ) VALUES (
        ${uuidv7()},
        ${businessId},
        ${reviewId},
        ${responseId},
        'zernio_review_id_mismatch',
        ${jsonb({
          our_review_id: reviewId,
          response_id: responseId,
          error_meta: errorMeta,
        })}
      )
      ON CONFLICT (review_id, type) WHERE status = 'open'
      DO UPDATE SET payload = review_exceptions.payload
      RETURNING id
    `;

    if (!exception) {
      logger.error(
        `review_exceptions UPSERT returned no row for response ${responseId} (review-not-found)`,
      );
      return false;
    }

    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()},
        'notify_admin_review_exception',
        'review',
        ${reviewId},
        ${jsonb({
          review_exception_id: exception.id,
          business_id: businessId,
        })},
        0,
        5
      )
    `;
    return true;
  });

  if (openedException) {
    logger.warn(
      `Zernio review id not found for response ${responseId}; opened review_exception`,
    );
  }
  await markOutboxCompleted(outboxId, outboxAttempt);
}
