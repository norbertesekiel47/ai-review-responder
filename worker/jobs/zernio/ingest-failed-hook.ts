import type { Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import { v7 as uuidv7 } from 'uuid';
import type { Sql, TransactionSql } from 'postgres';
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
    await handleReviewNotFound(sql, err, state);
    return;
  }

  if (err instanceof ZernioIngestPaginationCapExhaustedError) {
    await handlePaginationCapExhausted(sql, err, state);
    return;
  }

  if (err instanceof ZernioIngestUnparseableLocationError) {
    await handleUnparseableLocation(sql, err, state);
    return;
  }

  // Anything else: bare single-statement markOutboxFailed (existing behavior;
  // no coupled tx, so the crash guard MAY best-effort-fail it).
  const reason = err instanceof Error ? err.message : String(err);
  await markOutboxFailed(sql, state.outboxId!, reason, state.outboxAttempt);
}

/**
 * The CAS-first coupled-tx ownership contract, in one place: the outbox CAS
 * comes FIRST so only the executor that owns the terminal transition commits
 * the coupled writes (`fn` runs only on ownership); a stale attempt performs
 * no writes (markOutboxFailed contract), and a mid-sequence failure rolls
 * everything back for atomic watchdog recovery. Owns the
 * `coupledTerminalTxStarted` flag lifecycle: set before the tx opens, cleared
 * only after commit — on a throw it stays set, so the crash guard refuses to
 * split the rolled-back tx with a best-effort markOutboxFailed.
 *
 * Returns whether this attempt owned the transition, so callers can gate
 * post-commit observability (e.g. the pagination trend signal) on ownership.
 */
async function withOwnedTerminalTransition(
  sql: Sql,
  state: IngestFailedHookState,
  reason: string,
  fn: (tx: TransactionSql) => Promise<void>,
): Promise<boolean> {
  state.coupledTerminalTxStarted = true;
  let ownsAttempt = false;
  await sql.begin(async (tx) => {
    ownsAttempt = await markOutboxFailed(tx, state.outboxId!, reason, state.outboxAttempt);
    if (!ownsAttempt) return;
    await fn(tx);
  });
  state.coupledTerminalTxStarted = false;
  return ownsAttempt;
}

/**
 * Single owner of the review_exceptions dedup INSERT. The ON CONFLICT
 * predicate must match the partial index byte-for-byte (CLAUDE.md gotcha) —
 * keeping the SQL text here means there is exactly one copy to keep in sync.
 * Returns the new exception id, or null when an open exception already
 * suppressed the insert.
 */
async function insertReviewExceptionIfAbsent(
  tx: TransactionSql,
  businessId: string,
  type: string,
  payload: Record<string, string | number>,
): Promise<string | null> {
  const [exception] = await tx<{ id: string }[]>`
    INSERT INTO review_exceptions (id, business_id, type, status, payload)
    VALUES (${uuidv7()}, ${businessId}, ${type}, 'open', ${tx.json(payload as never)})
    ON CONFLICT (business_id, type, (payload->>'provider_review_id'))
      WHERE status = 'open' AND review_id IS NULL
    DO NOTHING
    RETURNING id
  `;
  return exception?.id ?? null;
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
  state: IngestFailedHookState,
): Promise<void> {
  await withOwnedTerminalTransition(sql, state, 'zernio_review_not_found_after_retries', async (tx) => {
    await insertReviewExceptionIfAbsent(tx, err.businessId, 'zernio_review_not_found', {
      provider: 'zernio',
      provider_review_id: err.zernioReviewId,
      zernio_account_id: err.zernioAccountId,
      zernio_location_id: err.zernioLocationId,
      pages_walked: err.pagesWalked,
      reviews_seen: err.reviewsSeen,
      retries_exhausted_at: new Date().toISOString(),
    });
  });
}

async function handlePaginationCapExhausted(
  sql: Sql,
  err: ZernioIngestPaginationCapExhaustedError,
  state: IngestFailedHookState,
): Promise<void> {
  const ownsAttempt = await withOwnedTerminalTransition(sql, state, 'zernio_pagination_cap_exhausted', async (tx) => {
    await insertReviewExceptionIfAbsent(tx, err.businessId, 'zernio_pagination_cap_exhausted', {
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
    });
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
  state: IngestFailedHookState,
): Promise<void> {
  await withOwnedTerminalTransition(sql, state, 'zernio_unparseable_review_name', async (tx) => {
    const exceptionId = await insertReviewExceptionIfAbsent(tx, err.businessId, 'zernio_unparseable_review_name', {
      provider: 'zernio',
      provider_review_id: err.zernioReviewId,
      zernio_account_id: err.zernioAccountId,
      zernio_location_id: err.zernioLocationId,
      review_name_truncated: err.reviewName.slice(0, 500),
      retries_exhausted_at: new Date().toISOString(),
    });

    if (exceptionId) {
      // Unparseable shape DOES warrant admin notify — signals contract change.
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
        VALUES (
          ${uuidv7()}, ${QUEUE_NAMES.NOTIFY_ADMIN}, 'business',
          ${err.businessId},
          ${tx.json({ review_exception_id: exceptionId, business_id: err.businessId } as never)},
          0, 5
        )
      `;
    }
  });
}
