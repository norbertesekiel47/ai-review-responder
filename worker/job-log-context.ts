import type { Job } from 'bullmq';
import {
  withLogContext,
  createRequestId,
  type LogContext,
} from '../src/lib/shared/log-context';

function asId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads the common tenant/correlation IDs that BullMQ payloads carry. Fields
 * absent on a given queue's payload are simply omitted. account_id is rarely on
 * the payload — handlers can add it via mergeLogContext once resolved from the DB.
 */
export function extractJobLogContext(job: Job): LogContext {
  const data = (job.data ?? {}) as Record<string, unknown>;
  return {
    request_id: createRequestId(),
    worker_job_id: asId(job.id),
    correlation_id: asId(data.correlation_id),
    account_id: asId(data.account_id),
    business_id: asId(data.business_id),
    review_id: asId(data.review_id),
    response_id: asId(data.response_id),
  };
}

/**
 * Wraps a BullMQ processor so every log line emitted while it runs carries the
 * job's context IDs. Apply at registration in worker/index.ts; handler code is
 * untouched.
 */
export function withJobLogContext<T>(
  handler: (job: Job<T>) => Promise<void>,
): (job: Job<T>) => Promise<void> {
  return (job: Job<T>) => withLogContext(extractJobLogContext(job as Job), () => handler(job));
}
