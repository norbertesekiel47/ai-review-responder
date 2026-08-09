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

const logger = createWorkerLogger('[JobFailureSink]');

/**
 * Terminal-attempt test for the **`'failed'` EVENT** context, where BullMQ has
 * ALREADY incremented `attemptsMade`.
 *
 * Deliberately NOT `isTerminalAttempt` from `src/lib/shared/outbox.ts`, even
 * though the plan's round-1 review directed reuse there. That helper is
 * `attemptsMade >= max || attemptsMade + 1 >= max`, written for the **catch
 * block**, where `attemptsMade` has not yet been incremented. The repo states
 * this outright and forbids merging the two — `worker/jobs/judge/failed-hook.ts`
 * keeps its own `isJudgeAttemptExhausted` and its comment ends "Both are correct
 * in their own call context; do not unify them."
 *
 * Used here, the catch-block form fires ONE ATTEMPT EARLY and then again on the
 * real last attempt: with `attempts: 3` it matches at `attemptsMade` 2 and 3 —
 * a duplicate Sentry issue plus a false "exhausted its retries" for a job BullMQ
 * then retries successfully.
 *
 * `attempts` defaults to 1 when unset or invalid, matching the sibling helpers,
 * so a queue with no explicit retry policy still reports its single failure.
 */
function isFailedEventTerminal(job: Job<unknown>): boolean {
  const maxAttempts =
    typeof job.opts.attempts === 'number' && job.opts.attempts > 0 ? job.opts.attempts : 1;
  return job.attemptsMade >= maxAttempts;
}

/**
 * Error NAME only, bounded. Mirrors csv-ingest's PII contract AND its
 * implementation (`worker/jobs/csv-ingest/failed-hook.ts:93-97`): a driver
 * message may embed contact handles, and string logger arguments bypass the
 * object sanitizer. The full error still reaches Sentry, which has its own
 * scrubber.
 *
 * The slice and the `'UnknownError'` fallback are copied deliberately rather
 * than approximated: `Error.name` is attacker-influenceable on a custom class,
 * and returning `typeof err` for a non-Error leaks nothing useful ("object")
 * while diverging from the sibling helper readers will compare this against.
 */
function boundedErrorClass(err: unknown): string {
  if (err instanceof Error && err.name) return err.name.slice(0, 100);
  return 'UnknownError';
}

export function reportJobFailure(queueName: string, job: Job | undefined, err: Error): void {
  try {
    if (!job || !isFailedEventTerminal(job)) return;

    Sentry.captureException(err, {
      // `topic` is a TAG, not merely `extra`, because the intake's observability
      // contract promises {queue, topic} and only tags are filterable and
      // groupable in Sentry. It is load-bearing rather than decorative: three
      // legacy aliases route onto the single `sendOwnerEmail` queue, so the
      // `queue` tag alone cannot identify which topic actually failed.
      tags: { subsystem: 'worker_job', queue: queueName, topic: job.name },
      extra: {
        job_id: job.id,
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
