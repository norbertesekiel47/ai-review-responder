// Terminal BullMQ job failure → a real Sentry issue.
//
// Before #719 the only reporting here was a Sentry *breadcrumb*, which attaches
// to some later unrelated event or to nothing at all. A handler that threw on
// every attempt therefore produced no issue, and the onboarding drip crashed
// deterministically for three months behind that gap.
//
// Deliberately does NOT touch job_outbox. The watchdog owns the status machine
// AND overwrites last_error unconditionally when it terminalizes
// (OutboxPoller.ts:140-143), so a write here is destroyed by the very message it
// would replace; queues that want durable per-domain error text own a domain
// 'failed' hook that writes it properly (see csv-ingest, solicitation-batch).
//
// Extracted rather than inlined per invariant #12.
import * as Sentry from '@sentry/node';
import type { Job, Worker } from 'bullmq';
import { createWorkerLogger, toError } from '../src/lib/shared/logger';
import { isTerminalAttempt } from '../src/lib/shared/outbox';

const logger = createWorkerLogger('[JobFailureSink]');

/**
 * Error NAME only. Mirrors csv-ingest's PII contract
 * (worker/jobs/csv-ingest/failed-hook.ts:93): a driver message may embed
 * contact handles, and string logger arguments bypass the object sanitizer.
 * The full error still reaches Sentry, which has its own scrubber.
 */
function boundedErrorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function reportJobFailure(queueName: string, job: Job | undefined, err: Error): void {
  try {
    if (!job || !isTerminalAttempt(job)) return;

    Sentry.captureException(err, {
      tags: { subsystem: 'worker_job', queue: queueName },
      extra: {
        job_id: job.id,
        job_name: job.name,
        outbox_id: (job.data as { outbox_id?: unknown } | undefined)?.outbox_id,
        attempts_made: job.attemptsMade,
      },
    });

    logger.error(`${queueName} job exhausted its retries`, {
      job_id: job.id,
      error_class: boundedErrorClass(err),
    });
  } catch (sinkError) {
    // Last-resort sink: a failure to REPORT a failure must never escalate.
    logger.error('job failure sink failed', toError(sinkError));
  }
}

export function attachJobFailureSink(worker: Pick<Worker, 'on'>, queueName: string): void {
  worker.on('failed', (job, err) => reportJobFailure(queueName, job, err));
}
