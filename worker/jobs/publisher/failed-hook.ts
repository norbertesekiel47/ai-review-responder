import type { Job } from 'bullmq';
import type postgres from 'postgres';
import type { Sql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import * as Sentry from '@sentry/node';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import {
  extractOutboxHandle,
  markOutboxFailed,
  markOutboxCompleted,
  markOutboxCompletedIfOwned,
} from '../../../src/lib/shared/outbox';
import { applyTransientExhaustionFallback } from '../../../src/lib/publishing/zernio-publisher';
import { ZernioTransientError } from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
} from './publisher-error-handlers';
import { isOrphanMarker, POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED } from '../../../src/lib/publishing/orphan-markers';
import { editRepliesEnabled } from '../../../src/lib/past-replies/flags';
import type { PublishResponsePayload } from '../../../src/lib/shared/worker-types';
import { anchorReviewLockOrder } from '../../../src/lib/approval/outcomes';
import { completeRun, findActiveReviewRun } from '../../../src/lib/agents/run-spine';
import { hasLiveOwnerActionableResponse } from '../live-draft-guard';

const PUBLISHABLE_STATUSES = ['approved', 'edited', 'awaiting_owner_connect'] as const;

interface PublisherFailedHookState {
  outboxId: string | undefined;
  outboxAttempt: number | undefined;
  coupledTerminalTxStarted: boolean;
}

/**
 * Take the publisher's canonical domain lane before attempting an outbox CAS.
 * The active publisher orders response -> outbox, so a failed-hook recovery
 * must never invert that edge by claiming the outbox before it locks the
 * response. The unlocked anchor pre-read is intentionally first; actual locks
 * are reviews -> businesses -> responses.
 */
async function lockPublisherFailureLane(
  tx: postgres.TransactionSql,
  responseId: string,
  businessId: string,
): Promise<string | null> {
  const reviewId = await anchorReviewLockOrder(tx, responseId, businessId);
  if (!reviewId) return null;

  const [business] = await tx<{ id: string }[]>`
    SELECT id
    FROM businesses
    WHERE id = ${businessId}
    FOR UPDATE
  `;
  if (!business) return null;

  const [response] = await tx<{ id: string }[]>`
    SELECT id
    FROM responses
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND review_id = ${reviewId}
    FOR UPDATE
  `;
  return response ? reviewId : null;
}

function exhaustedJob(
  job: Job<PublishResponsePayload> | undefined,
): Job<PublishResponsePayload> | null {
  if (!job) return null;
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return null;
  return job;
}

async function tryOrphanExhaustion(
  sql: Sql,
  job: Job<PublishResponsePayload>,
  state: PublisherFailedHookState,
): Promise<boolean> {
  if (!editRepliesEnabled()) return false;
  state.coupledTerminalTxStarted = true;
  const handled = await attemptOrphanConversion(
    sql,
    job.data,
    state.outboxId!,
    state.outboxAttempt,
  );
  state.coupledTerminalTxStarted = false;
  return handled;
}

async function handleTransientPublisherExhaustion(
  sql: Sql,
  job: Job<PublishResponsePayload>,
  err: ZernioTransientError,
  state: PublisherFailedHookState,
): Promise<void> {
  if (!(err instanceof PublisherTransientWithContext)) {
    console.error('[publisherWorker] bare ZernioTransientError reached failed-hook — missing PublisherTransientWithContext wrap upstream');
    Sentry.captureException(err, {
      tags: { worker: 'publisher', kind: 'unwrapped_transient' },
      level: 'error',
      extra: { response_id: job.data.response_id, business_id: job.data.business_id },
    });
    const reason = err instanceof Error ? err.message : String(err);
    state.coupledTerminalTxStarted = true;
    await checkpointTerminalPublisherFailure(
      sql,
      job.data,
      state.outboxId!,
      `unwrapped_transient_no_context: ${reason}`,
      state.outboxAttempt,
    );
    return;
  }

  const ctx = err.attemptContext;
  try {
    state.coupledTerminalTxStarted = true;
    await sql.begin(async (tx) => {
      await lockPublisherFailureLane(tx, ctx.response_id, ctx.business_id);
      const ownsAttempt = await markOutboxFailed(
        tx,
        state.outboxId!,
        'zernio_transient_max_attempts',
        state.outboxAttempt,
      );
      if (!ownsAttempt) return;
      await applyTransientExhaustionFallback(tx, {
        response_id: ctx.response_id,
        business_id: ctx.business_id,
        correlation_id: job.data.correlation_id,
      });
    });
    state.coupledTerminalTxStarted = false;
  } catch (fallbackErr) {
    const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    console.error(`[publisherWorker] transient-exhaustion fallback failed: ${reason}`);
    Sentry.captureException(fallbackErr, {
      tags: { worker: 'publisher', kind: 'transient_exhaustion_fallback' },
    });
    state.coupledTerminalTxStarted = true;
    await checkpointTerminalPublisherFailure(
      sql,
      job.data,
      state.outboxId!,
      `zernio_transient_max_attempts_fallback_failed: ${reason}`,
      state.outboxAttempt,
    );
    return;
  }
}

async function dispatchPublisherExhaustion(
  sql: Sql,
  job: Job<PublishResponsePayload>,
  err: unknown,
  state: PublisherFailedHookState,
): Promise<void> {
  if (await tryOrphanExhaustion(sql, job, state)) return;
  if (err instanceof ZernioReplyVerificationIndeterminateError) {
    state.coupledTerminalTxStarted = true;
    await handleVerificationIndeterminate(sql, err, state.outboxId!, state.outboxAttempt);
    state.coupledTerminalTxStarted = false;
    return;
  }
  if (err instanceof ZernioTransientError) {
    await handleTransientPublisherExhaustion(sql, job, err, state);
    return;
  }
  const reason = err instanceof Error ? err.message : String(err);
  state.coupledTerminalTxStarted = true;
  await checkpointTerminalPublisherFailure(
    sql,
    job.data,
    state.outboxId!,
    reason,
    state.outboxAttempt,
  );
}

async function capturePublisherFailedHookCrash(
  sql: Sql,
  state: PublisherFailedHookState,
  handlerErr: unknown,
): Promise<void> {
  console.error('[publisherWorker.on(failed)] handler crashed:', handlerErr);
  Sentry.captureException(handlerErr, {
    tags: { worker: 'publisher', kind: 'on_failed_handler_crash' },
  });
  if (!state.outboxId || state.coupledTerminalTxStarted) return;
  const reason = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
  await markOutboxFailed(
    sql,
    state.outboxId,
    `on_failed_crash: ${reason}`,
    state.outboxAttempt,
  ).catch((markErr) => {
    console.error('[publisherWorker.on(failed)] best-effort markOutboxFailed failed:', markErr);
  });
}

/**
 * Final-attempt exhaustion handler for ResponsePublisherWorker. BullMQ retries
 * transient errors automatically; only the LAST failure (attemptsMade ===
 * opts.attempts) reaches this branch as exhaustion. For ZernioTransientError
 * at exhaustion we run the graceful-degradation fallback (disconnect + park
 * the response + notify owner). For any other unhandled error we just close
 * the outbox row so it doesn't sit in `dispatched` forever.
 */
export async function handlePublisherFailed(
  sql: Sql,
  job: Job<PublishResponsePayload> | undefined,
  err: unknown,
): Promise<void> {
  // Top-level guard: any throw in extractOutboxHandle, markOutboxFailed, or
  // applyTransientExhaustionFallback bubbles into an unhandled promise
  // rejection that could crash the process. Wrap the whole body so we
  // log + Sentry-capture and never leave the outbox row in `dispatched`
  // limbo silently.
  const state: PublisherFailedHookState = {
    outboxId: undefined,
    outboxAttempt: undefined,
    coupledTerminalTxStarted: false,
  };
  try {
    const terminalJob = exhaustedJob(job);
    if (!terminalJob) return;
    const handle = extractOutboxHandle(terminalJob.data, terminalJob.id!);
    state.outboxId = handle.outboxId;
    state.outboxAttempt = handle.attempt;
    await dispatchPublisherExhaustion(sql, terminalJob, err, state);
  } catch (handlerErr) {
    // Last-resort: capture loudly so a row left `dispatched` is observable.
    // Never split a coupled terminal checkpoint after its transaction throws:
    // its outbox CAS rolled back with the run/response write, so the watchdog
    // must recover it atomically later. Genuinely outbox-only failures (notably
    // reconnect fallback succeeded but its standalone close failed) may retry
    // that standalone close here because their run intentionally stays running.
    await capturePublisherFailedHookCrash(sql, state, handlerErr);
  }
}

export async function checkpointTerminalPublisherFailure(
  sql: Sql,
  data: PublishResponsePayload,
  outboxId: string,
  reason: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql.begin(async (tx) => {
    // The reusable anchor pre-reads response.review_id, then takes the review
    // lock before any run/child-row lock in this transaction.
    const reviewId = await anchorReviewLockOrder(tx, data.response_id, data.business_id);
    if (reviewId) {
      const transitioned = await markOutboxFailed(tx, outboxId, reason, outboxAttempt);
      if (!transitioned) return;

      const activeRun = await findActiveReviewRun(tx, reviewId);
      if (activeRun) {
        await completeRun(tx, activeRun.id, 'failed', { reason });
      }
      return;
    }
    await markOutboxFailed(tx, outboxId, reason, outboxAttempt);
  });
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
  sql: Sql,
  data: PublishResponsePayload,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<boolean> {
  const { response_id, business_id } = data;

  // Single-field box so the closure mutation narrows across `await sql.begin`
  // (a bare `let x = 'fall_through'` gets pinned to that literal by TS narrowing
  // and the post-await comparisons would be flagged as having no overlap).
  type Disposition = 'fall_through' | 'completed' | 'failed' | 'stale_attempt';
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

    // 6. Claim this exact dispatched outbox attempt before mutating response
    //    or run state. A stale worker loses cleanly and leaves newer work alone.
    const transitioned = await markOutboxFailed(
      tx,
      outboxId,
      POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED,
      outboxAttempt,
    );
    if (!transitioned) {
      dispositionRef.value = 'stale_attempt';
      return;
    }

    // 7. Convert. Status-guarded, business-scoped, affected-row asserted.
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

    const activeRun = await findActiveReviewRun(tx, responseRow.review_id);
    if (activeRun) {
      await completeRun(tx, activeRun.id, 'failed', {
        reason: POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED,
      });
    }
    dispositionRef.value = 'failed';
  });

  if (dispositionRef.value === 'completed') {
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return true;
  }
  if (dispositionRef.value === 'failed') {
    return true;
  }
  if (dispositionRef.value === 'stale_attempt') {
    return true;
  }
  return false;
}

async function handleVerificationIndeterminate(
  sql: Sql,
  err: ZernioReplyVerificationIndeterminateError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  await sql.begin(async (tx) => {
    // Lock order is review -> business -> response -> outbox. In particular,
    // the response FOR UPDATE precedes the completion CAS because the active
    // publisher takes the same response -> outbox edge.
    const reviewId = await lockPublisherFailureLane(
      tx,
      err.meta.response_id,
      err.meta.business_id,
    );

    const ownsAttempt = await markOutboxCompletedIfOwned(tx, outboxId, outboxAttempt);
    if (!ownsAttempt || !reviewId) return;

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
        ${tx.json({
          reason: err.meta.reason,
          zernio_account_id: err.meta.account_id,
          zernio_location_id: err.meta.location_id,
          zernio_review_id: err.meta.zernio_review_id,
          pages_walked: err.meta.pages_walked,
          reviews_seen: err.meta.reviews_seen,
          underlying_error: err.meta.underlying_error,
          retries_exhausted_at: new Date().toISOString(),
        } as never)}
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
          ${uuidv7()}, ${QUEUE_NAMES.NOTIFY_ADMIN}, 'review',
          ${err.meta.review_id},
          ${tx.json({ review_exception_id: exception.id, business_id: err.meta.business_id } as never)},
          0, 5
        )
      `;
    }

    // WS5 §3: indeterminate verification is terminal for the review's
    // handling — complete the run 'failed' in the SAME tx as the responses
    // write above (previously the run stayed running forever → permanent
    // "Stalled" timeline). Live-draft guard for symmetry with
    // checkpointTerminalGeneration: the row just went 'failed' (not live),
    // so this normally completes; only another still-owner-actionable draft
    // keeps the run running. completeRun stays LAST — agent_runs after the
    // reviews/responses/child-row locks per the global order.
    if (await hasLiveOwnerActionableResponse(tx, reviewId, err.meta.business_id)) return;
    const activeRun = await findActiveReviewRun(tx, reviewId);
    if (activeRun) {
      await completeRun(tx, activeRun.id, 'failed', {
        reason: 'zernio_reply_verification_indeterminate',
      });
    }
  });
}
