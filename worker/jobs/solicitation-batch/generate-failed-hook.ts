import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle, markOutboxFailed } from '@/lib/shared/outbox';
import type { GenerateSolicitationAsksPayload } from '@/lib/shared/worker-types';

const logger = createWorkerLogger('[GenerateSolicitationAsksWorker.failed]');

function isExhausted(job: Job<GenerateSolicitationAsksPayload>): boolean {
  const maxAttempts =
    typeof job.opts.attempts === 'number' && job.opts.attempts > 0
      ? job.opts.attempts
      : 1;
  return job.attemptsMade >= maxAttempts;
}

function boundedErrorClass(err: unknown): string {
  if (!(err instanceof Error)) return 'UnknownError';
  const constructorName = err.constructor.name;
  return /^[A-Za-z][A-Za-z0-9_$]{0,99}$/.test(constructorName)
    ? constructorName
    : 'UnknownError';
}

function logFailureSafely(
  details: Record<string, string | number | boolean>,
): void {
  try {
    logger.error('ask generation exhausted', details);
  } catch {
    // Terminal state is already durable (or the row stayed dispatched for the
    // watchdog). Logging is observability-only and must never escape a bare
    // BullMQ failed listener.
  }
}

/**
 * Exhausted-attempt terminalizer for generate_solicitation_asks: an
 * attempt-guarded CAS marks the dispatched outbox row failed, so the watchdog
 * stops re-driving it and operators keep a diagnosis/re-drive surface.
 *
 * Deliberately NO send-parent terminalization, unlike the sibling build
 * failed-hook: `closeBatchIfSettled` owns every send-parent terminal
 * transition (the batch → run single-join contract in outreach.ts), only the
 * domain finale can know whether the batch settled, and on the regeneration
 * path the parent is healthy — the existing render stays live. An operator
 * re-drive resumes idempotently (SPEC §7.4): every ask holding any
 * non-cancelled outreach row is skipped before a cent is reserved.
 */
export async function handleGenerateSolicitationAsksFailed(
  sql: Sql,
  job: Job<GenerateSolicitationAsksPayload> | undefined,
  err: unknown,
): Promise<void> {
  if (!job || !isExhausted(job)) return;

  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
  const errorClass = boundedErrorClass(err);
  const jobFields = {
    batch_id: job.data.batch_id,
    business_id: job.data.business_id,
    ask_id: job.data.ask_id ?? '',
  };

  if (attempt === undefined) {
    logFailureSafely({
      status: 'missing_exact_attempt',
      ...jobFields,
      error_class: errorClass,
    });
    return;
  }

  let ownsAttempt: boolean;
  try {
    ownsAttempt = await markOutboxFailed(
      sql,
      outboxId,
      `generate_solicitation_asks_exhausted:${errorClass}`,
      attempt,
    );
  } catch (hookErr) {
    // The CAS itself failed: leave the row dispatched for watchdog recovery
    // rather than retrying inside a bare BullMQ failed listener.
    logFailureSafely({
      status: 'terminal_checkpoint_failed',
      ...jobFields,
      outbox_attempt: attempt,
      error_class: boundedErrorClass(hookErr),
    });
    return;
  }

  logFailureSafely({
    status: ownsAttempt ? 'terminalized' : 'stale',
    ...jobFields,
    outbox_attempt: attempt,
    error_class: errorClass,
  });
}
