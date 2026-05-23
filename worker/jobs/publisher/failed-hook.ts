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
import { isOrphanMarker, POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED } from './orphan-markers';
import type { PublishResponsePayload } from '../../../src/lib/shared/worker-types';

const PUBLISHABLE_STATUSES = ['approved', 'edited', 'awaiting_owner_connect'] as const;

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

    // Orphan-marker retry-exhaustion conversion (spec §4.5) runs BEFORE the
    // generic transient fallback. When the edit-publisher's DELETE committed
    // but the POST never succeeded, the row carries a `_after_delete_succeeded`
    // orphan marker. On retry exhaustion we must convert it to a
    // recovery-visible `failed` row (so `/retry` + `/restore-original` can act)
    // instead of letting the transient fallback park it at
    // `awaiting_owner_connect` and clear the marker. Flag-gated so Phase A
    // (flag off) behaves byte-for-byte as today — the block is skipped entirely
    // and the existing fallback below runs directly.
    if (process.env.EDIT_REPLIES_ENABLED === 'true') {
      const handled = await attemptOrphanConversion(job.data, outboxId, outboxAttempt);
      if (handled) return;
      // Not an orphan (or row moved on benignly with a non-terminal disposition
      // that already closed the outbox): fall through to today's behavior.
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
      const ctx = err.attemptContext;
      try {
        await applyTransientExhaustionFallback({
          response_id: ctx.response_id,
          business_id: ctx.business_id,
          correlation_id: job.data.correlation_id,
          account_id: ctx.account_id,
          location_id: ctx.location_id,
        });
        await markOutboxFailed(outboxId, 'zernio_transient_max_attempts', outboxAttempt);
      } catch (fallbackErr) {
        // Fallback itself failed — surface the reason so ops can see it,
        // and still close the outbox so the row doesn't stay `dispatched`.
        const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        console.error(`[publisherWorker] transient-exhaustion fallback failed: ${reason}`);
        Sentry.captureException(fallbackErr, {
          tags: { worker: 'publisher', kind: 'transient_exhaustion_fallback' },
        });
        await markOutboxFailed(
          outboxId,
          `zernio_transient_max_attempts_fallback_failed: ${reason}`,
          outboxAttempt,
        );
      }
      return;
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

/**
 * Spec §4.5 "Retry exhaustion conversion". Runs in ONE tx using the canonical
 * review → response lock order (matches `processReview`, avoids deadlocks) and
 * business-scopes every statement with `business_id` from the failed job's
 * payload. Returns `true` when this hook took terminal ownership of the outbox
 * row (converted an orphan → `failed`, or idempotently completed because the
 * row is no longer publishable / not visible). Returns `false` when the row is
 * NOT an orphan, so the caller falls through to the existing transient
 * fallback (today's behavior, unchanged).
 */
async function attemptOrphanConversion(
  data: PublishResponsePayload,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<boolean> {
  const { response_id, business_id } = data;

  // Single-field box so the closure mutation narrows across `await sql.begin`
  // (a bare `let x = 'fall_through'` gets pinned to that literal by TS narrowing
  // and the post-await comparisons would be flagged as having no overlap).
  type Disposition = 'fall_through' | 'completed' | 'failed';
  const dispositionRef: { value: Disposition } = { value: 'fall_through' };

  await sql.begin(async (tx) => {
    // 1. Read the response's review_id (business-scoped). No row → not visible
    //    to this tenant (mismatch) or already deleted; both benign. Close the
    //    outbox cleanly rather than crash.
    const [responseRow] = await tx<{ review_id: string }[]>`
      SELECT review_id FROM responses
      WHERE id = ${response_id} AND business_id = ${business_id}
    `;
    if (!responseRow) {
      dispositionRef.value = 'completed';
      return;
    }

    // 2. Lock the review FIRST — canonical order with processReview.
    const [reviewLock] = await tx<{ id: string }[]>`
      SELECT id FROM reviews
      WHERE id = ${responseRow.review_id} AND business_id = ${business_id}
      FOR UPDATE
    `;
    if (!reviewLock) {
      // response references a review not visible to its business — should be
      // impossible if FKs hold. Alert + close the outbox.
      Sentry.captureMessage('orphan_response_review', {
        level: 'warning',
        extra: { response_id, business_id },
      });
      dispositionRef.value = 'completed';
      return;
    }

    // 3. Lock the response (business-scoped). If processReview ran concurrently
    //    it has already committed; we read the post-processReview state here.
    const [lockedResp] = await tx<{ status: string; posting_error: string | null }[]>`
      SELECT status, posting_error FROM responses
      WHERE id = ${response_id} AND business_id = ${business_id}
      FOR UPDATE
    `;
    if (!lockedResp) {
      // Race: deleted between the step-1 read and the lock acquisition.
      dispositionRef.value = 'completed';
      return;
    }

    // 4. Status guard. processReview's supersede branch can move the row out
    //    from under us — never un-supersede deliberate terminal state.
    if (!PUBLISHABLE_STATUSES.includes(lockedResp.status as (typeof PUBLISHABLE_STATUSES)[number])) {
      dispositionRef.value = 'completed';
      return;
    }

    // 5. Orphan-marker check (via shared helper — no literals).
    if (!isOrphanMarker(lockedResp.posting_error)) {
      // No marker → nothing to commit. Leave disposition 'fall_through' so the
      // caller runs the generic fallback (no writes pending → commit ≡ rollback).
      return;
    }

    // 6. Convert. Status-guarded, business-scoped, affected-row asserted.
    const updated = await tx`
      UPDATE responses
      SET status = 'failed',
          posting_error = ${POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED},
          updated_at = NOW()
      WHERE id = ${response_id}
        AND business_id = ${business_id}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (updated.count !== 1) {
      throw new Error(
        `onFailed orphan conversion expected 1 row, got ${updated.count}`,
      );
    }
    dispositionRef.value = 'failed';
  });

  if (dispositionRef.value === 'completed') {
    await markOutboxCompleted(outboxId, outboxAttempt);
    return true;
  }
  if (dispositionRef.value === 'failed') {
    await markOutboxFailed(outboxId, POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED, outboxAttempt);
    return true;
  }
  return false;
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
