import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import * as Sentry from '@sentry/node';
import { sql, jsonb } from '../../../src/lib/db/server';
import {
  extractOutboxHandle,
  markOutboxFailed,
  markOutboxCompleted,
} from '../../../src/lib/shared/outbox';
import { applyTransientExhaustionFallback } from '../../../src/lib/publishing/zernio-publisher';
import { ZernioTransientError } from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from './publisher-error-handlers';
import type { PublishResponsePayload } from '../../../src/lib/shared/worker-types';

/**
 * Final-attempt exhaustion handler for ResponsePublisherWorker. BullMQ retries
 * transient errors automatically; only the LAST failure (attemptsMade ===
 * opts.attempts) reaches this branch as exhaustion. For ZernioTransientError
 * at exhaustion we run the graceful-degradation fallback (disconnect + park
 * the response + notify owner). For any other unhandled error we just close
 * the outbox row so it doesn't sit in `dispatched` forever.
 */
export async function handlePublisherFailed(
  job: Job<PublishResponsePayload> | undefined,
  err: unknown,
): Promise<void> {
  // Top-level guard: any throw in extractOutboxHandle, markOutboxFailed, or
  // applyTransientExhaustionFallback bubbles into an unhandled promise
  // rejection that could crash the process. Wrap the whole body so we
  // log + Sentry-capture and never leave the outbox row in `dispatched`
  // limbo silently.
  let outboxId: string | undefined;
  let outboxAttempt: number | undefined;
  try {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return; // not yet exhausted
    const handle = extractOutboxHandle(job.data, job.id!);
    outboxId = handle.outboxId;
    outboxAttempt = handle.attempt;

    if (err instanceof ZernioReplyVerificationIndeterminateError) {
      await handleVerificationIndeterminate(err, outboxId, outboxAttempt);
      return;
    }

    if (err instanceof ZernioTransientError) {
      // Unwrap PublisherTransientWithContext for the pinned disconnect.
      // Bare ZernioTransientError without context is now a CODE BUG —
      // every publisher path wraps transient throws (postReply, lookup,
      // 409 verifier). Surface loudly via Sentry rather than silently
      // disconnecting every active connection (the previous safety-net
      // fallback was deleted because it was unsafe with multi-connection
      // businesses).
      if (!(err instanceof PublisherTransientWithContext)) {
        console.error('[publisherWorker] bare ZernioTransientError reached failed-hook — missing PublisherTransientWithContext wrap upstream');
        Sentry.captureException(err, {
          tags: { worker: 'publisher', kind: 'unwrapped_transient' },
          level: 'error',
          extra: { response_id: job.data.response_id, business_id: job.data.business_id },
        });
        // Still close the outbox so the row doesn't stay dispatched.
        const reason = err instanceof Error ? err.message : String(err);
        await markOutboxFailed(outboxId, `unwrapped_transient_no_context: ${reason}`, outboxAttempt);
        return;
      }
      // PublisherTransientWithContext branch will be added in Task 11.
    }

    // Non-transient unhandled error: just close the outbox row.
    const reason = err instanceof Error ? err.message : String(err);
    await markOutboxFailed(outboxId, reason, outboxAttempt);
  } catch (handlerErr) {
    // Last-resort: even the markOutboxFailed call (or extractOutboxHandle,
    // or anything else above) threw. Capture loudly so the row stuck in
    // `dispatched` is observable in Sentry, and attempt one more
    // best-effort markOutboxFailed in case the original throw was upstream.
    console.error('[publisherWorker.on(failed)] handler crashed:', handlerErr);
    Sentry.captureException(handlerErr, {
      tags: { worker: 'publisher', kind: 'on_failed_handler_crash' },
    });
    if (outboxId) {
      const reason = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
      await markOutboxFailed(outboxId, `on_failed_crash: ${reason}`, outboxAttempt).catch(
        (markErr) => {
          console.error('[publisherWorker.on(failed)] best-effort markOutboxFailed failed:', markErr);
        },
      );
    }
  }
}

async function handleVerificationIndeterminate(
  err: ZernioReplyVerificationIndeterminateError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql.begin(async (tx) => {
    const updated = await tx`
      UPDATE responses
      SET status = 'failed',
          posting_error = 'zernio_reply_verification_indeterminate',
          updated_at = NOW()
      WHERE id = ${err.meta.response_id}
        AND business_id = ${err.meta.business_id}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (updated.count === 0) return;

    const [exception] = await tx<{ id: string }[]>`
      INSERT INTO review_exceptions (
        id, business_id, review_id, response_id, type, payload
      ) VALUES (
        ${uuidv7()}, ${err.meta.business_id}, ${err.meta.review_id},
        ${err.meta.response_id}, 'zernio_reply_verification_indeterminate',
        ${jsonb({
          reason: err.meta.reason,
          zernio_account_id: err.meta.account_id,
          zernio_location_id: err.meta.location_id,
          zernio_review_id: err.meta.zernio_review_id,
          pages_walked: err.meta.pages_walked,
          reviews_seen: err.meta.reviews_seen,
          underlying_error: err.meta.underlying_error,
          retries_exhausted_at: new Date().toISOString(),
        })}
      )
      ON CONFLICT (review_id, type) WHERE status = 'open'
      DO UPDATE SET payload = review_exceptions.payload
      RETURNING id
    `;

    if (exception) {
      await tx`
        INSERT INTO job_outbox (
          id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
        ) VALUES (
          ${uuidv7()}, 'notify_admin_review_exception', 'review',
          ${err.meta.review_id},
          ${jsonb({ review_exception_id: exception.id, business_id: err.meta.business_id })},
          0, 5
        )
      `;
    }
  });
  await markOutboxCompleted(outboxId, outboxAttempt);
}
