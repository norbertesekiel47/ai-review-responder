import { v7 as uuidv7 } from 'uuid';
import { jsonb, sql } from '../../../src/lib/db/server';
import { lookupZernioReviewId } from '../../../src/lib/publishing/zernio-publisher';
import { markOutboxCompleted } from '../../../src/lib/shared/outbox';
import {
  ZernioReviewNotFoundError,
  ZernioTransientError,
} from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
} from './publisher-error-handlers';
import type { ZernioConnectionRow } from './types';

export async function resolvePublishableZernioReviewId(input: {
  responseId: string;
  businessId: string;
  reviewId: string;
  zernioConnection: ZernioConnectionRow;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: { log(message: string): void; warn(message: string): void; error(message: string): void };
}): Promise<string | 'completed'> {
  const {
    responseId,
    businessId,
    reviewId,
    zernioConnection,
    outboxId,
    outboxAttempt,
    logger,
  } = input;

  try {
    return await lookupZernioReviewId(
      businessId,
      reviewId,
      zernioConnection.zernio_account_id,
      zernioConnection.zernio_location_id,
    );
  } catch (err) {
    if (err instanceof ZernioReviewNotFoundError) {
      await sql.begin(async (tx) => {
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
          return;
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
              error_meta: err.meta,
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
          return;
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
      });

      logger.warn(
        `Zernio review id not found for response ${responseId}; opened review_exception`,
      );
      await markOutboxCompleted(outboxId, outboxAttempt);
      return 'completed';
    }

    if (err instanceof ZernioTransientError) {
      throw new PublisherTransientWithContext(err, {
        response_id: responseId,
        business_id: businessId,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
      });
    }
    throw err;
  }
}
