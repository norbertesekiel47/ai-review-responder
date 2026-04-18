export interface WorkerLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Creates a structured logger for BullMQ workers with optional correlation ID.
 *
 * Output: [WorkerName] [corr-id] message args...
 *    or:  [WorkerName] message args...          (when no correlation ID)
 *
 * Usage:
 *   const logger = createWorkerLogger('[ReviewSyncWorker]', job.data.correlation_id);
 *   logger.log('processing review', reviewId);
 */
export function createWorkerLogger(
  prefix: string,
  correlationId?: string,
): WorkerLogger {
  const tag = correlationId ? `${prefix} [${correlationId}]` : prefix;

  return {
    log: (...args: unknown[]) => console.log(tag, ...args),
    warn: (...args: unknown[]) => console.warn(tag, ...args),
    error: (...args: unknown[]) => console.error(tag, ...args),
  };
}
