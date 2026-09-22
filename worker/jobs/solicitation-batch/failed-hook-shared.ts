import type { Job } from 'bullmq';

/**
 * The mechanics every solicitation-batch `failed` listener needs, owned once.
 *
 * Both hooks in this folder independently grew the same helpers — BullMQ
 * exhaustion arithmetic and a swallow-everything logger — differing only in
 * their log message. Two copies of "how do we decide a job is exhausted" is two
 * places to get it wrong; the duplication was caught by the fallow clone
 * detector on #628. The log-safe error-class name that used to live here is
 * lane-neutral and moved to `src/lib/shared/error-inspect.ts` (#1381).
 *
 * Deliberately NOT generalized past this folder: the publisher and zernio
 * failed-hooks classify their own transport errors and have different
 * exhaustion semantics. One owner per fact, not one helper for every lane.
 */

/**
 * True once BullMQ has spent every in-band attempt. `job.opts.attempts` is
 * optional and may be absent or nonsensical on a hand-enqueued job, so a
 * missing or non-positive value reads as the single-attempt default rather
 * than letting the hook fire early.
 */
export function isExhaustedJob(job: Job<unknown>): boolean {
  const maxAttempts =
    typeof job.opts.attempts === 'number' && job.opts.attempts > 0
      ? job.opts.attempts
      : 1;
  return job.attemptsMade >= maxAttempts;
}

/**
 * Build the hook's log-and-swallow reporter. Terminal state is already durable
 * by the time these run (or the row was deliberately left for the watchdog),
 * so logging is observability-only and must never escape a bare BullMQ `failed`
 * listener — an throw there is an unhandled rejection, not a retry.
 */
export function makeFailureLogger(
  logger: { error: (message: string, details?: Record<string, unknown>) => void },
  message: string,
): (details: Record<string, string | number | boolean>) => void {
  return (details) => {
    try {
      logger.error(message, details);
    } catch {
      // See the contract above: observability must not poison the hook.
    }
  };
}
