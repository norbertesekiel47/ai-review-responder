import { setTimeout as delay } from 'node:timers/promises';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { CostInfraUnavailableError } from '@/lib/costs/errors';
import { TransientLLMError } from '@/lib/llm/error-classifier';
import { settleGenerationExhaustion } from '@/lib/solicitation/ask-generation';
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

/**
 * True when the watchdog will grant this dispatched row another re-drive
 * (attempts < max_attempts). On the FINAL attempt even a retryable class must
 * settle terminally — the generic OutboxPoller's max_attempts terminalizer
 * knows nothing about this lane's domain state, so leaving the row dispatched
 * would strand a partially generated batch when it fires (codex round-3
 * finding 1). A missing row has nothing left to re-drive, so it reads as no
 * budget; a FAILED read errs toward the watchdog (the prior behavior) and is
 * logged so the fallback is visible.
 */
async function watchdogRetryRemaining(
  sql: Sql,
  outboxId: string,
): Promise<boolean> {
  try {
    const [row] = await sql<{ attempts: number; max_attempts: number }[]>`
      SELECT attempts, max_attempts FROM job_outbox WHERE id = ${outboxId}
    `;
    return row !== undefined && row.attempts < row.max_attempts;
  } catch (readErr) {
    logFailureSafely({
      status: 'watchdog_budget_read_failed',
      outbox_id: outboxId,
      error_class: boundedErrorClass(readErr),
    });
    return true;
  }
}

/**
 * Extra settlement attempts granted when the watchdog has none left. Small and
 * short on purpose: this runs inside a bare BullMQ `failed` listener, so it
 * must not hold the worker for long, and the settlement is one small
 * transaction whose realistic failure is a brief pool blip.
 */
const FINAL_SETTLEMENT_RETRIES = 2;
const FINAL_SETTLEMENT_BACKOFF_MS = 200;

/**
 * Whole-batch dead-letter: the coupled CAS + domain settlement, committed or
 * rolled back as one unit.
 *
 * A settlement failure has two cases the old single catch could not tell apart
 * (codex round-4 finding 1), split here by watchdog budget:
 * - budget REMAINS → leave the row `dispatched`. The watchdog re-pends it, the
 *   job runs again, and this hook gets another honest attempt. Retrying inside
 *   a bare failed listener would only duplicate what the watchdog already owns.
 * - budget EXHAUSTED → there is no re-driver left. The generic OutboxPoller
 *   terminalizer will mark the row failed knowing nothing about this lane's
 *   domain state, stranding a partially generated batch behind a running send
 *   parent, so the settlement is retried HERE, bounded.
 *
 * When those are spent the lane is conceded to an operator under its own
 * status (`terminal_settlement_abandoned`) rather than the ambiguous
 * checkpoint status — the two need to be distinguishable in an alert, because
 * only this one means "nothing will retry this."
 */
async function deadLetterWholeBatch(
  sql: Sql,
  job: Job<GenerateSolicitationAsksPayload>,
  outboxHandle: { outboxId: string; attempt: number },
  errorClass: string,
  jobFields: Record<string, string>,
): Promise<void> {
  for (let retriesLeft = FINAL_SETTLEMENT_RETRIES; ; retriesLeft -= 1) {
    try {
      const settled = await settleGenerationExhaustion(sql, {
        batchId: job.data.batch_id,
        businessId: job.data.business_id,
        outboxHandle,
        errorClass,
      });
      logFailureSafely({
        status: settled.status === 'settled' ? 'terminalized_and_settled' : settled.status,
        ...jobFields,
        outbox_attempt: outboxHandle.attempt,
        error_class: errorClass,
        ...(settled.status === 'settled'
          ? { filled: settled.filled, close_status: settled.close.status }
          : {}),
      });
      return;
    } catch (hookErr) {
      const settlementErrorClass = boundedErrorClass(hookErr);
      if (await watchdogRetryRemaining(sql, outboxHandle.outboxId)) {
        logFailureSafely({
          status: 'terminal_checkpoint_failed',
          ...jobFields,
          outbox_attempt: outboxHandle.attempt,
          error_class: settlementErrorClass,
        });
        return;
      }
      if (retriesLeft === 0) {
        logFailureSafely({
          status: 'terminal_settlement_abandoned',
          ...jobFields,
          outbox_attempt: outboxHandle.attempt,
          error_class: settlementErrorClass,
        });
        return;
      }
      await delay(FINAL_SETTLEMENT_BACKOFF_MS);
    }
  }
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
 * Exhausted-attempt handler for generate_solicitation_asks.
 *
 * Retryable classes (isRetryableExhaustion) leave the row dispatched — the
 * watchdog is the out-of-band re-driver once in-band BullMQ attempts run out.
 *
 * Terminal classes split by payload:
 * - WHOLE-BATCH job: `settleGenerationExhaustion` — one transaction couples
 *   the outbox-failed CAS with the domain settlement (withheld render_failed
 *   fills for un-rendered send asks + closeBatchIfSettled(generation_failed)),
 *   so a permanent failure cannot strand a running send parent behind missing
 *   rows (codex round-2 finding 4).
 * - REGENERATION job: the bare attempt-guarded CAS only. The batch's parent
 *   and existing render are healthy — the failed regeneration changes nothing
 *   an operator cannot re-drive, and `closeBatchIfSettled` keeps its single
 *   set of legitimate callers.
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

  if (isRetryableExhaustion(err) && (await watchdogRetryRemaining(sql, outboxId))) {
    // In-band BullMQ attempts are exhausted but the failure class is
    // transient AND the watchdog still has re-drives left: leave the row
    // 'dispatched' so it re-pends. Marking it failed here would strand a
    // partially generated batch behind a running send parent with no
    // re-driver; the §7.4 DB-existence idempotency makes the re-drive
    // resume, not re-spend. When no watchdog budget remains, fall through —
    // a retryable class with no re-driver left is terminal NOW, and the
    // dead-letter below settles the lane instead of the generic poller
    // terminalizer stranding it (codex round-3 finding 1).
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

  if (job.data.ask_id === undefined) {
    await deadLetterWholeBatch(sql, job, { outboxId, attempt }, errorClass, jobFields);
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
