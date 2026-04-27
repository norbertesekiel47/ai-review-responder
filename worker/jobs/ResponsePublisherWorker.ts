import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { jsonb, sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import type { PublishResponsePayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { lookupZernioReviewId } from '../../src/lib/publishing/zernio-publisher';
import { zernioClient } from '../../src/lib/zernio/client';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyExistsError,
  ZernioReviewNotFoundError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../src/lib/zernio/errors';

interface ZernioConnectionRow {
  zernio_account_id: string;
  zernio_location_id: string;
}

export async function handlePublishResponse(
  job: Job<PublishResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponsePublisherWorker]', job.data.correlation_id);
  const { response_id, business_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // ── Step 1: Load response + review + business ──────────────────────
  const [response] = await sql<{
    id: string;
    review_id: string;
    business_id: string;
    approved_text: string | null;
    status: string;
  }[]>`
    SELECT id, review_id, business_id, approved_text, status
    FROM responses
    WHERE id = ${response_id}
  `;

  if (!response) {
    logger.error(`Response ${response_id} not found`);
    await markOutboxFailed(outboxId, `response_not_found: ${response_id}`, outboxAttempt);
    return;
  }

  if (response.business_id !== business_id) {
    logger.error(`Response ${response_id} belongs to business ${response.business_id}, not ${business_id}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch', outboxAttempt);
    return;
  }

  const [business] = await sql<{
    id: string;
    name: string;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT id, name, subscription_status, updated_at
    FROM businesses
    WHERE id = ${business_id}
  `;

  if (!business) {
    logger.error(`Business ${business_id} not found`);
    await markOutboxFailed(outboxId, `business_not_found: ${business_id}`, outboxAttempt);
    return;
  }

  // ── Step 2: Idempotency — only 'posted' is terminal ─────────────────
  if (response.status === 'posted') {
    logger.log(`Response ${response_id} already posted, skipping`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 3: Subscription guard ─────────────────────────────────────
  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'publisher',
  );

  if (!subCheck.allowed) {
    logger.warn(
      `Business ${business_id} subscription blocked: ${subCheck.reason}`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 4: Load active Zernio connection ──────────────────────────
  const [zernioConnection] = await sql<ZernioConnectionRow[]>`
    SELECT zernio_account_id, zernio_location_id
    FROM zernio_connections
    WHERE business_id = ${business_id} AND status = 'active'
    LIMIT 1
  `;

  // ── Step 5: Branch on connection presence ──────────────────────────
  if (!zernioConnection) {
    // Branch A — NO active connection. Transition response to
    // awaiting_owner_connect and enqueue the reconnect notify outbox row.
    // No connection_lost here — that's reserved for the auth-error path
    // where a connection actually went bad mid-publish.
    await sql.begin(async (tx) => {
      const updated = await tx`
        UPDATE responses
        SET status = 'awaiting_owner_connect', updated_at = NOW()
        WHERE id = ${response_id}
          AND business_id = ${business_id}
          AND status IN ('approved', 'edited', 'awaiting_owner_connect')
        RETURNING 1
      `;

      if (updated.count === 0) {
        // Already terminal (posted by parallel worker, failed, superseded).
        // Skip notify enqueue — owner doesn't need an email about a row
        // they no longer need to act on.
        logger.log(
          `Response ${response_id} already terminal (status=${response.status}), skipping reconnect notify`,
        );
        return;
      }

      await tx`
        INSERT INTO job_outbox (
          id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
        ) VALUES (
          ${uuidv7()},
          'notify_owner_reconnect',
          'response',
          ${response_id},
          ${jsonb({
            kind: 'reconnect_required',
            response_id,
            business_id,
          })},
          0,
          5
        )
      `;
    });

    logger.log(
      `No active Zernio connection for business ${business_id}; response ${response_id} parked at awaiting_owner_connect`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // Branch B — active connection found. Resolve Zernio's review id, then
  // post the reply.
  const approvedText = response.approved_text ?? '';
  if (!response.approved_text) {
    logger.warn(
      `Response ${response_id} has null approved_text — Zernio reply body will be empty`,
    );
  }

  // ── Step 6: Resolve our internal review id → Zernio's review id ─────
  let zernioReviewId: string;
  try {
    zernioReviewId = await lookupZernioReviewId(
      business_id,
      response.review_id,
      zernioConnection.zernio_account_id,
    );
  } catch (err) {
    if (err instanceof ZernioReviewNotFoundError) {
      // Permanent: review not findable on Zernio. Mark response failed
      // (status-guarded), open a review_exception, and notify admin.
      await sql.begin(async (tx) => {
        const updated = await tx`
          UPDATE responses
          SET status = 'failed', updated_at = NOW()
          WHERE id = ${response_id}
            AND business_id = ${business_id}
            AND status IN ('approved', 'edited', 'awaiting_owner_connect')
          RETURNING 1
        `;

        if (updated.count === 0) {
          // Row already terminal (posted/failed/superseded). No exception
          // to file. Outbox should still complete cleanly.
          logger.log(
            `Response ${response_id} already terminal, skipping zernio_review_id_mismatch exception`,
          );
          return;
        }

        const [exception] = await tx<{ id: string }[]>`
          INSERT INTO review_exceptions (
            id, business_id, review_id, response_id, type, payload
          ) VALUES (
            ${uuidv7()},
            ${business_id},
            ${response.review_id},
            ${response_id},
            'zernio_review_id_mismatch',
            ${jsonb({
              our_review_id: response.review_id,
              response_id,
              error_meta: err.meta,
            })}
          )
          ON CONFLICT (review_id, type) WHERE status = 'open'
          DO UPDATE SET payload = review_exceptions.payload
          RETURNING id
        `;

        if (!exception) {
          // Should never happen — ON CONFLICT DO UPDATE always returns a row.
          // Defensive: log + skip notify enqueue rather than crash inside the tx.
          logger.error(
            `review_exceptions UPSERT returned no row for response ${response_id} (review-not-found)`,
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
            ${response.review_id},
            ${jsonb({
              review_exception_id: exception.id,
              business_id,
            })},
            0,
            5
          )
        `;
      });

      logger.warn(
        `Zernio review id not found for response ${response_id}; opened review_exception`,
      );
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }
    // Any other error during lookup (transient list_reviews failure, DB
    // error, etc.) bubbles so BullMQ retries. ZernioTransientError is the
    // common case here; the onFailed handler in worker/index.ts handles
    // exhaustion via applyTransientExhaustionFallback.
    throw err;
  }

  // ── Step 7: Post the reply via Zernio ──────────────────────────────
  try {
    await zernioClient.postReply(
      zernioConnection.zernio_account_id,
      zernioReviewId,
      { comment: approvedText },
    );
  } catch (err) {
    // ── ZernioReplyAlreadyExistsError: treat as idempotent success ───
    if (err instanceof ZernioReplyAlreadyExistsError) {
      await sql`
        UPDATE responses
        SET status = 'posted', posted_at = NOW(), updated_at = NOW()
        WHERE id = ${response_id}
          AND business_id = ${business_id}
          AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      `;
      logger.log(
        `Response ${response_id} already posted on Zernio (409), marked posted`,
      );
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }

    // ── ZernioAuthError: connection broken — graceful degradation ────
    if (err instanceof ZernioAuthError) {
      const errorBody = err.body.slice(0, 500);
      await sql.begin(async (tx) => {
        await tx`
          UPDATE zernio_connections
          SET status = 'disconnected',
              disconnected_at = NOW(),
              disconnect_reason = 'auth_error_on_post',
              last_error = ${errorBody},
              last_error_at = NOW()
          WHERE business_id = ${business_id} AND status = 'active'
        `;

        const updated = await tx`
          UPDATE responses
          SET status = 'awaiting_owner_connect', updated_at = NOW()
          WHERE id = ${response_id}
            AND business_id = ${business_id}
            AND status IN ('approved', 'edited', 'awaiting_owner_connect')
          RETURNING 1
        `;

        if (updated.count === 0) {
          // Response already terminal (posted/failed/superseded). The
          // connection mutation above is still useful; skip the notify
          // enqueues so we don't email about a non-stuck response.
          logger.log(
            `Response ${response_id} already terminal during auth-error path; skipped notify enqueues`,
          );
          return;
        }

        await tx`
          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
          ) VALUES
            (
              ${uuidv7()},
              'notify_owner_reconnect',
              'response',
              ${response_id},
              ${jsonb({
                kind: 'reconnect_required',
                response_id,
                business_id,
              })},
              0,
              5
            ),
            (
              ${uuidv7()},
              'notify_owner_connection_lost',
              'business',
              ${business_id},
              ${jsonb({ kind: 'connection_lost', business_id })},
              0,
              5
            )
        `;
      });

      logger.warn(
        `Zernio auth error on post for business ${business_id}; connection disconnected, response ${response_id} parked`,
      );
      // Auth failure is NOT transient; do NOT throw. Complete the outbox.
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }

    // ── ZernioPermanentError / ZernioValidationError: terminal ───────
    // Idempotent endpoint hit a permanent client-side problem. Open a
    // review_exception and mark the response failed. Connection state
    // is untouched — this is request-specific, not connection-wide.
    if (err instanceof ZernioPermanentError || err instanceof ZernioValidationError) {
      const endpointKind =
        err instanceof ZernioPermanentError && typeof err.meta?.endpointKind === 'string'
          ? err.meta.endpointKind
          : 'publish_reply';
      const errorBody =
        err instanceof ZernioPermanentError ? err.meta : { code: err.code, body: err.body };

      await sql.begin(async (tx) => {
        const updated = await tx`
          UPDATE responses
          SET status = 'failed', updated_at = NOW()
          WHERE id = ${response_id}
            AND business_id = ${business_id}
            AND status IN ('approved', 'edited', 'awaiting_owner_connect')
          RETURNING 1
        `;

        if (updated.count === 0) {
          logger.log(
            `Response ${response_id} already terminal during permanent-error path; skipped exception`,
          );
          return;
        }

        const [exception] = await tx<{ id: string }[]>`
          INSERT INTO review_exceptions (
            id, business_id, review_id, response_id, type, payload
          ) VALUES (
            ${uuidv7()},
            ${business_id},
            ${response.review_id},
            ${response_id},
            'zernio_permanent_4xx',
            ${jsonb({
              response_id,
              endpoint_kind: endpointKind,
              error_body: errorBody,
              http_status: 400,
            })}
          )
          ON CONFLICT (review_id, type) WHERE status = 'open'
          DO UPDATE SET payload = review_exceptions.payload
          RETURNING id
        `;

        if (!exception) {
          // Should never happen — ON CONFLICT DO UPDATE always returns a row.
          logger.error(
            `review_exceptions UPSERT returned no row for response ${response_id} (permanent_4xx)`,
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
            ${response.review_id},
            ${jsonb({
              review_exception_id: exception.id,
              business_id,
            })},
            0,
            5
          )
        `;
      });

      logger.warn(
        `Zernio permanent error on post for response ${response_id}; opened review_exception`,
      );
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }

    // ── ZernioTransientError: re-throw so BullMQ retries ─────────────
    // Final-attempt exhaustion is handled by the publisherWorker.on('failed')
    // hook in worker/index.ts (Task 22), which calls
    // applyTransientExhaustionFallback to disconnect + park the response.
    if (err instanceof ZernioTransientError) {
      throw err;
    }

    // ── Unknown error: re-throw ───────────────────────────────────────
    // Programming bugs, DB exceptions, etc. Bubble so BullMQ retries
    // and the onFailed handler closes the outbox row on exhaustion.
    throw err;
  }

  // ── Step 8: Success ────────────────────────────────────────────────
  await sql`
    UPDATE responses
    SET status = 'posted', posted_at = NOW(), updated_at = NOW()
    WHERE id = ${response_id}
      AND business_id = ${business_id}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
  `;

  logger.log(
    `Response ${response_id} posted via Zernio for business ${business_id}`,
  );

  await markOutboxCompleted(outboxId, outboxAttempt);
}
