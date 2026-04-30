import { createHash } from 'node:crypto';
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
import {
  handlePublisherAuthErrorTerminal,
  handlePublisherPermanentErrorTerminal,
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from './publisher-error-handlers';
import { canonicalizeReplyText } from '../../src/lib/zernio/canonicalize-reply';

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

  // ── Step 2: Publishable-state gate ──────────────────────────────────
  //
  // Only proceed for states that represent owner-approved responses ready
  // to publish via Zernio. Bailing here is critical: without it, a 'failed'
  // or 'superseded' response would still call zernioClient.postReply,
  // creating a real reply on Google that we then fail to record (the
  // status-guarded UPDATE no-ops). 'pending_approval' would post an
  // unapproved response, violating the no-auto-posting invariant.
  //
  // This list mirrors the UPDATE WHERE clauses below and matches
  // AWAITING_PUBLISH_STATUSES exactly.
  const ZERNIO_PUBLISHABLE_STATES = ['approved', 'edited', 'awaiting_owner_connect'] as const;
  if (!(ZERNIO_PUBLISHABLE_STATES as readonly string[]).includes(response.status)) {
    logger.log(
      `Response ${response_id} not in publishable state (status=${response.status}), skipping`,
    );
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
      zernioConnection.zernio_location_id,
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
    // error, etc.) bubbles so BullMQ retries. Wrap ZernioTransientError
    // with attempt context so the failed-hook can pin the disconnect to
    // the attempted account+location (mirrors postReply path).
    if (err instanceof ZernioTransientError) {
      throw new PublisherTransientWithContext(err, {
        response_id,
        business_id,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
      });
    }
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
    // ── ZernioReplyAlreadyExistsError: verify-first per spec §6.10b ──
    // 409 does NOT mean it was us — walk pages to confirm the reply text
    // before marking posted. Mismatch → supersede. Indeterminate → retry.
    if (err instanceof ZernioReplyAlreadyExistsError) {
      // 409 verify-first per spec §6.10b. Walk pages — Zernio paginates at 50,
      // target review may be older than the most recent 50.
      let allReviews;
      try {
        allReviews = await zernioClient.listAllReviews(
          zernioConnection.zernio_account_id,
          {
            locationId: zernioConnection.zernio_location_id,
            pageSize: 50,
            maxPages: 4,
          },
        );
      } catch (lookupErr) {
        if (lookupErr instanceof ZernioTransientError) {
          logger.warn(
            `409 verifier hit transient error for response ${response_id}: ${lookupErr.message} — wrapping for retry`,
          );
          throw new PublisherTransientWithContext(lookupErr, {
            response_id,
            business_id,
            account_id: zernioConnection.zernio_account_id,
            location_id: zernioConnection.zernio_location_id,
          });
        }
        if (lookupErr instanceof ZernioAuthError) {
          logger.warn(`409 verifier hit auth error for response ${response_id}`);
          await handlePublisherAuthErrorTerminal({
            response_id,
            business_id,
            account_id: zernioConnection.zernio_account_id,
            location_id: zernioConnection.zernio_location_id,
            error_body: lookupErr.body ? String(lookupErr.body).slice(0, 500) : lookupErr.message,
            outboxId,
            outboxAttempt,
            correlation_id: job.data.correlation_id,
            logger,
          });
          return;
        }
        if (lookupErr instanceof ZernioPermanentError || lookupErr instanceof ZernioValidationError) {
          logger.error(`409 verifier hit permanent error for response ${response_id}: ${lookupErr.message}`);
          const endpointKind =
            lookupErr instanceof ZernioPermanentError && typeof lookupErr.meta?.endpointKind === 'string'
              ? lookupErr.meta.endpointKind
              : 'list_reviews';
          const errBody =
            lookupErr instanceof ZernioPermanentError
              ? lookupErr.meta
              : { code: lookupErr.code, body: lookupErr.body };
          await handlePublisherPermanentErrorTerminal({
            response_id,
            business_id,
            review_id: response.review_id,
            endpoint_kind: endpointKind,
            http_status: 400,
            error_body: errBody,
            outboxId,
            outboxAttempt,
            logger,
          });
          return;
        }
        logger.warn(
          `409 verifier hit unknown error for response ${response_id}: ` +
          `${lookupErr instanceof Error ? lookupErr.message : lookupErr} — wrapping as indeterminate, retrying`,
        );
        throw new ZernioReplyVerificationIndeterminateError({
          response_id, business_id, review_id: response.review_id,
          account_id: zernioConnection.zernio_account_id,
          location_id: zernioConnection.zernio_location_id,
          zernio_review_id: zernioReviewId,
          reason: 'verifier_unknown_error',
          underlying_error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
        });
      }

      const found = allReviews.find((r) => r.id === zernioReviewId);

      if (!found) {
        logger.warn(
          `409 verifier could not locate review ${zernioReviewId} after walking ${allReviews.length} reviews — indeterminate, retrying`,
        );
        throw new ZernioReplyVerificationIndeterminateError({
          response_id, business_id, review_id: response.review_id,
          account_id: zernioConnection.zernio_account_id,
          location_id: zernioConnection.zernio_location_id,
          zernio_review_id: zernioReviewId,
          reason: 'review_not_found_after_pagination',
          pages_walked: 4, reviews_seen: allReviews.length,
        });
      }

      const existingReply = found.reviewReply ?? null;

      if (existingReply === null) {
        logger.warn(
          `409 verifier found review ${zernioReviewId} but reviewReply=null — indeterminate (Zernio lag?), retrying`,
        );
        throw new ZernioReplyVerificationIndeterminateError({
          response_id, business_id, review_id: response.review_id,
          account_id: zernioConnection.zernio_account_id,
          location_id: zernioConnection.zernio_location_id,
          zernio_review_id: zernioReviewId,
          reason: 'review_found_but_reply_null',
        });
      }

      const existingText = canonicalizeReplyText(existingReply.comment);
      const ourText = canonicalizeReplyText(approvedText);

      if (existingText === ourText) {
        await sql`
          UPDATE responses
          SET status = 'posted', posted_at = NOW(), updated_at = NOW()
          WHERE id = ${response_id}
            AND business_id = ${business_id}
            AND status IN ('approved', 'edited', 'awaiting_owner_connect')
        `;
        logger.log(`Response ${response_id} already posted on Zernio (409, text match), marked posted`);
        await markOutboxCompleted(outboxId, outboxAttempt);
        return;
      }

      await sql`
        UPDATE responses
        SET status = 'superseded',
            posting_error = 'already_replied_external',
            updated_at = NOW()
        WHERE id = ${response_id}
          AND business_id = ${business_id}
          AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      `;
      const fp = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
      logger.warn(
        `Response ${response_id} 409 text mismatch — ` +
        `existing(len=${existingText.length},fp=${fp(existingText)}) ` +
        `ours(len=${ourText.length},fp=${fp(ourText)}) ` +
        `— superseded as already_replied_external`,
      );
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }

    // ── ZernioAuthError: connection broken — delegate to shared helper ─
    if (err instanceof ZernioAuthError) {
      await handlePublisherAuthErrorTerminal({
        response_id,
        business_id,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
        error_body: err.body ? String(err.body).slice(0, 500) : err.message,
        outboxId,
        outboxAttempt,
        correlation_id: job.data.correlation_id,
        logger,
      });
      return;
    }

    // ── ZernioPermanentError / ZernioValidationError: terminal ───────
    if (err instanceof ZernioPermanentError || err instanceof ZernioValidationError) {
      const endpointKind =
        err instanceof ZernioPermanentError && typeof err.meta?.endpointKind === 'string'
          ? err.meta.endpointKind
          : 'publish_reply';
      const errBody =
        err instanceof ZernioPermanentError ? err.meta : { code: err.code, body: err.body };

      await handlePublisherPermanentErrorTerminal({
        response_id,
        business_id,
        review_id: response.review_id,
        endpoint_kind: endpointKind,
        http_status: 400,
        error_body: errBody,
        outboxId,
        outboxAttempt,
        logger,
      });
      return;
    }

    // ── ZernioTransientError: wrap with context + re-throw for retry ──
    // The failed-hook in worker/index.ts uses PublisherTransientWithContext
    // to pin the disconnect to the attempted account+location on exhaustion.
    if (err instanceof ZernioTransientError) {
      throw new PublisherTransientWithContext(err, {
        response_id,
        business_id,
        account_id: zernioConnection.zernio_account_id,
        location_id: zernioConnection.zernio_location_id,
      });
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
