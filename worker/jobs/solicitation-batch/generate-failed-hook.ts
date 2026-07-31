import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { CostInfraUnavailableError } from '@/lib/costs/errors';
import { TransientLLMError } from '@/lib/llm/error-classifier';
import { createWorkerLogger } from '@/lib/shared/logger';
import {
  extractOutboxHandle,
  markOutboxFailed,
  recordOutboxTransientError,
} from '@/lib/shared/outbox';
import type { GenerateSolicitationAsksPayload } from '@/lib/shared/worker-types';

const logger = createWorkerLogger('[GenerateSolicitationAsksWorker.failed]');

/**
 * The exhaustion classes that stay WATCHDOG-ELIGIBLE: exactly the two the
 * domain rethrows for retry (generateChildRender's contract, SPEC §7.5). A
 * strict lane-local allowlist on purpose (the crash-net precedent): anything
 * else — including an unknown error — terminalizes, because an unclassified
 * failure re-driven forever is worse than an operator re-drive. Deliberately
 * NOT generalized to the sibling hooks: the build lane's failures are
 * DB-shaped (no LLM call), and the publisher lane already classifies via
 * ZernioTransientError in its own failed-hook.
 */
function isRetryableExhaustion(err: unknown): boolean {
  return err instanceof TransientLLMError || err instanceof CostInfraUnavailableError;
}

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
 * Exhausted-attempt handler for generate_solicitation_asks. Terminal failure
 * classes: an attempt-guarded CAS marks the dispatched outbox row failed, so
 * the watchdog stops re-driving it and operators keep a diagnosis/re-drive
 * surface. Retryable classes (isRetryableExhaustion) instead leave the row
 * dispatched — the watchdog is the out-of-band re-driver once in-band BullMQ
 * attempts run out.
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

  if (isRetryableExhaustion(err)) {
    // In-band BullMQ attempts are exhausted but the failure class is
    // transient: leave the row 'dispatched' so the watchdog re-pends it
    // (bounded by job_outbox.max_attempts — beyond that the watchdog itself
    // terminalizes). Marking it failed here would strand a partially
    // generated batch behind a running send parent with no re-driver; the
    // §7.4 DB-existence idempotency makes the re-drive resume, not re-spend.
    await recordOutboxTransientError(
      sql,
      outboxId,
      `generate_solicitation_asks_exhausted_retryable:${errorClass}`,
      attempt,
    );
    logFailureSafely({
      status: 'watchdog_eligible',
      ...jobFields,
      outbox_attempt: attempt,
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
