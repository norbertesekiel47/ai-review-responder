import type { Job } from 'bullmq';
import * as Sentry from '@sentry/node';
import type { Sql } from 'postgres';
import {
  acquireCsvIngestLock,
  writeTerminalUploadState,
  type IngestReport,
} from '@/lib/solicitation/ingest';
import { UPLOAD_STATUSES } from '@/lib/solicitation/upload-status';
import { extractOutboxHandle, markOutboxFailed } from '@/lib/shared/outbox';
import type { CsvIngestPayload } from '@/lib/shared/worker-types';

interface CsvIngestFailedHookState {
  outboxId?: string;
  outboxAttempt?: number;
  coupledTerminalTxStarted: boolean;
}

/**
 * Retry-exhaustion terminalizer for the csv_ingest worker (mirrors
 * worker/jobs/zernio/ingest-failed-hook.ts). Without it a permanent DB error
 * leaves the upload 'pending' forever — and the observability contract says
 * stuck-in-processing must mean BROKEN, not routine. On BullMQ exhaustion the
 * upload is terminalized to status='failed' with an `error: 'ingest_failed'`
 * report, and raw_csv is cleared in the SAME transaction (§3: the raw blob's
 * lifetime is bounded by processing, success or failure).
 *
 * Race safety: the transaction FIRST takes the SAME per-business advisory
 * lock as ingestContactsCsvUpload and re-reads status under it (the
 * status='pending' predicate), so terminalization can never race an in-flight
 * retry; the outbox CAS (markOutboxFailed) then gates the coupled write so a
 * stale attempt that lost to the watchdog performs no mutation.
 *
 * PII contract: only the bounded error CLASS is persisted/logged — a raw error
 * message (e.g. a Postgres unique-violation detail) can embed handle values.
 */
export async function handleCsvIngestFailed(
  sql: Sql,
  job: Job<CsvIngestPayload> | undefined,
  err: unknown,
): Promise<void> {
  // Top-level guard: this runs as a bare Worker 'failed' listener, so any
  // throw here becomes an unhandled rejection — which the crash-net treats
  // as fatal for non-transient-DB errors. One upload's failure bookkeeping
  // must never take down all queues. Mirrors handleIngestFailed (zernio).
  const state: CsvIngestFailedHookState = { coupledTerminalTxStarted: false };
  try {
    if (!job) return;
    if (job.attemptsMade < (job.opts.attempts ?? 3)) return; // not yet exhausted

    const handle = extractOutboxHandle(job.data, job.id!);
    state.outboxId = handle.outboxId;
    state.outboxAttempt = handle.attempt;

    const failedReport: IngestReport = {
      contactsCreated: 0,
      contactsMerged: 0,
      visitsAdded: 0,
      duplicateVisits: 0,
      rejected: [],
      structuralFailure: null,
      error: 'ingest_failed',
    };

    state.coupledTerminalTxStarted = true;
    await sql.begin(async (tx) => {
      await acquireCsvIngestLock(tx, job.data.business_id);
      const ownsAttempt = await markOutboxFailed(
        tx,
        state.outboxId!,
        `csv_ingest_exhausted:${boundedErrorClass(err)}`,
        state.outboxAttempt,
      );
      if (!ownsAttempt) return; // a newer dispatched attempt owns the row
      // Stays AFTER the CAS, in the CAS's transaction. The writer owns the
      // status='pending' predicate, which no-ops if the job actually completed
      // (or a concurrent run terminalized) after this failure was recorded.
      // business_id is bound too — the payload's business_id is the same
      // trusted aggregate the advisory lock above is keyed on.
      await writeTerminalUploadState(tx, {
        uploadId: job.data.upload_id,
        businessId: job.data.business_id,
        status: UPLOAD_STATUSES.FAILED,
        report: failedReport,
      });
    });
    state.coupledTerminalTxStarted = false;
  } catch (handlerErr) {
    await captureCsvIngestFailedHookCrash(sql, state, handlerErr);
  }
}

/** Error NAME only, bounded — never the message (may embed handle values). */
function boundedErrorClass(err: unknown): string {
  if (err instanceof Error && err.name) return err.name.slice(0, 100);
  return 'UnknownError';
}

async function captureCsvIngestFailedHookCrash(
  sql: Sql,
  state: CsvIngestFailedHookState,
  handlerErr: unknown,
): Promise<void> {
  // This IS the last-resort catch — nothing in here may throw.
  try {
    // Error class only on the console line (PII contract); Sentry gets the
    // full exception through the worker/sentry.ts scrubber.
    console.error(
      `[csvIngestWorker.on(failed)] handler crashed: ${boundedErrorClass(handlerErr)}`,
    );
    Sentry.captureException(handlerErr, {
      tags: { worker: 'csv_ingest', kind: 'on_failed_handler_crash' },
    });
  } catch {
    // Swallow: even a Sentry/logging failure must not re-throw here.
  }
  // Never split a coupled terminal tx after rollback: the row is still
  // 'dispatched', so the watchdog must recover the whole sequence atomically.
  if (!state.outboxId || state.coupledTerminalTxStarted) return;
  await markOutboxFailed(
    sql,
    state.outboxId,
    `on_failed_crash: ${boundedErrorClass(handlerErr)}`,
    state.outboxAttempt,
  ).catch((markErr) => {
    console.error(
      `[csvIngestWorker.on(failed)] best-effort markOutboxFailed failed: ${boundedErrorClass(markErr)}`,
    );
  });
}
