import type { Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
import { QUEUE_NAMES } from '../../../src/lib/shared/queue-names';
import { extractOutboxHandle, markOutboxFailed } from '../../../src/lib/shared/outbox';
import {
  ZernioIngestReviewNotFoundError,
  ZernioIngestPaginationCapExhaustedError,
  ZernioIngestUnparseableLocationError,
} from './ZernioReviewIngestWorker';
import type { IngestZernioReviewPayload } from '../../../src/lib/shared/worker-types';

interface IngestFailedHookState {
  outboxId?: string;
  outboxAttempt?: number;
  coupledTerminalTxStarted: boolean;
}

/**
 * Final-attempt exhaustion handler for ZernioReviewIngestWorker. Typed errors
 * from the worker (ZernioIngestReviewNotFoundError, ZernioIngestPaginationCapExhaustedError,
 * ZernioIngestUnparseableLocationError) escalate to review_exceptions after BullMQ retries
 * are exhausted; the admin notify is deliberately skipped for review_not_found (high-volume
 * during Zernio outages would spam admin email; ops watches the table).
 */
export async function handleIngestFailed(
  sql: Sql,
  job: Job<IngestZernioReviewPayload> | undefined,
  err: unknown,
): Promise<void> {
  // Top-level guard: this runs as a bare Worker 'failed' listener, so any
  // throw here becomes an unhandled rejection — which the crash-net treats
  // as fatal for non-transient-DB errors. One review's failure bookkeeping
  // must never take down all queues. Mirrors handlePublisherFailed.
  const state: IngestFailedHookState = { coupledTerminalTxStarted: false };
  try {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 5)) return; // not yet exhausted

    const handle = extractOutboxHandle(job.data, job.id!);
    state.outboxId = handle.outboxId;
    state.outboxAttempt = handle.attempt;
    await dispatchIngestExhaustion(sql, err, state);
  } catch (handlerErr) {
    await captureIngestFailedHookCrash(sql, state, handlerErr);
  }
}

async function dispatchIngestExhaustion(
  sql: Sql,
  err: unknown,
  state: IngestFailedHookState,
): Promise<void> {
  if (err instanceof ZernioIngestReviewNotFoundError) {
    state.coupledTerminalTxStarted = true;
    await handleReviewNotFound(sql, err, state.outboxId!, state.outboxAttempt);
    state.coupledTerminalTxStarted = false;
    return;
  }

  if (err instanceof ZernioIngestPaginationCapExhaustedError) {
    state.coupledTerminalTxStarted = true;
    await handlePaginationCapExhausted(sql, err, state.outboxId!, state.outboxAttempt);
    state.coupledTerminalTxStarted = false;
    return;
  }

  if (err instanceof ZernioIngestUnparseableLocationError) {
    state.coupledTerminalTxStarted = true;
    await handleUnparseableLocation(sql, err, state.outboxId!, state.outboxAttempt);
    state.coupledTerminalTxStarted = false;
    return;
  }

  // Anything else: bare single-statement markOutboxFailed (existing behavior;
  // no coupled tx, so the crash guard MAY best-effort-fail it).
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(sql, state.outboxId!, reason, state.outboxAttempt);
}

async function captureIngestFailedHookCrash(
  sql: Sql,
  state: IngestFailedHookState,
  handlerErr: unknown,
): Promise<void> {
  // This IS the last-resort catch — nothing in here may throw. (Hardened vs
  // the publisher template, which leaves the Sentry call unguarded.)
  try {
    console.error('[ingestZernioReviewWorker.on(failed)] handler crashed:', handlerErr);
    Sentry.captureException(handlerErr, {
      tags: { worker: 'ingest_zernio_review', kind: 'on_failed_handler_crash' },
    });
  } catch {
    // Swallow: even a Sentry/logging failure must not re-throw here.
  }
  // Never split a coupled terminal tx after rollback: the row is still
  // `dispatched`, so the watchdog must recover the whole sequence atomically.
  if (!state.outboxId || state.coupledTerminalTxStarted) return;
  const reason = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
  await markOutboxFailed(sql, state.outboxId, `on_failed_crash: ${reason}`, state.outboxAttempt).catch((markErr) => {
    console.error('[ingestZernioReviewWorker.on(failed)] best-effort markOutboxFailed failed:', markErr);
  });
}

async function handleReviewNotFound(
  sql: Sql,
  err: ZernioIngestReviewNotFoundError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  // One tx per handler: the outbox CAS comes FIRST so only the executor that
  // owns the terminal transition commits the exception row; a stale attempt
  // performs no writes (markOutboxFailed contract), and a mid-sequence failure
  // rolls everything back for atomic watchdog recovery.
  await sql.begin(async (tx) => {
    const ownsAttempt = await markOutboxFailed(tx, outboxId, 'zernio_review_not_found_after_retries', outboxAttempt);
    if (!ownsAttempt) return;
    await tx`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_review_not_found', 'open',
        ${tx.json({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          pages_walked: err.pagesWalked,
          reviews_seen: err.reviewsSeen,
          retries_exhausted_at: new Date().toISOString(),
        } as never)}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
    `;
  });
}

async function handlePaginationCapExhausted(
  sql: Sql,
  err: ZernioIngestPaginationCapExhaustedError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  // CAS-first coupled tx — see handleReviewNotFound for the ownership contract.
  let ownsAttempt = false;
  await sql.begin(async (tx) => {
    ownsAttempt = await markOutboxFailed(tx, outboxId, 'zernio_pagination_cap_exhausted', outboxAttempt);
    if (!ownsAttempt) return;
    await tx`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_pagination_cap_exhausted', 'open',
        ${tx.json({
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
        } as never)}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
    `;
  });
  if (!ownsAttempt) return;

  // Trend-only Sentry signal — admin notify is intentionally skipped
  // (potential high-volume), but ops needs visibility on cap-exhaustion
  // rate so the cap can be tuned via ZERNIO_INGEST_MAX_PAGES. Emitted
  // AFTER commit, and only by the attempt that owned the transition
  // (observability must not sit inside the tx or double-fire on stale hooks).
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
}

async function handleUnparseableLocation(
  sql: Sql,
  err: ZernioIngestUnparseableLocationError,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  // CAS-first coupled tx — see handleReviewNotFound for the ownership contract.
  await sql.begin(async (tx) => {
    const ownsAttempt = await markOutboxFailed(tx, outboxId, 'zernio_unparseable_review_name', outboxAttempt);
    if (!ownsAttempt) return;

    const [exception] = await tx<{ id: string }[]>`
      INSERT INTO review_exceptions (id, business_id, type, status, payload)
      VALUES (
        ${uuidv7()}, ${err.businessId}, 'zernio_unparseable_review_name', 'open',
        ${tx.json({
          provider: 'zernio',
          provider_review_id: err.zernioReviewId,
          zernio_account_id: err.zernioAccountId,
          zernio_location_id: err.zernioLocationId,
          review_name_truncated: err.reviewName.slice(0, 500),
          retries_exhausted_at: new Date().toISOString(),
        } as never)}
      )
      ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
        WHERE status = 'open' AND review_id IS NULL
      DO NOTHING
      RETURNING id
    `;

    if (exception) {
      // Unparseable shape DOES warrant admin notify — signals contract change.
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
        VALUES (
          ${uuidv7()}, ${QUEUE_NAMES.NOTIFY_ADMIN}, 'business',
          ${err.businessId},
          ${tx.json({ review_exception_id: exception.id, business_id: err.businessId } as never)},
          0, 5
        )
      `;
    }
  });
}
