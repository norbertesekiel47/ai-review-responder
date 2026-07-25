import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { failSolicitationBatchRun } from '@/lib/agents/run-spine';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle, markOutboxFailed } from '@/lib/shared/outbox';
import type { BuildSolicitationBatchPayload } from '@/lib/shared/worker-types';

const logger = createWorkerLogger('[SolicitationBatchWorker.failed]');

function isExhausted(job: Job<BuildSolicitationBatchPayload>): boolean {
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
    logger.error('solicitation batch build exhausted', details);
  } catch {
    // Terminal state already committed (or rolled back as a unit). Logging is
    // observability-only and must never escape a bare BullMQ failed listener.
  }
}

/**
 * Exhausted-attempt terminalizer for build_solicitation_batch.
 *
 * The outbox ownership CAS is the transaction's first statement. Only its
 * winner may fail the matching active parent; a stale hook writes nothing.
 * The unbuilt batch is deliberately retained with built_at NULL so owner RLS
 * keeps it hidden while operators retain a diagnosis/re-drive surface.
 */
export async function handleSolicitationBatchFailed(
  sql: Sql,
  job: Job<BuildSolicitationBatchPayload> | undefined,
  err: unknown,
): Promise<void> {
  if (!job || !isExhausted(job)) return;

  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
  const errorClass = boundedErrorClass(err);
  if (attempt === undefined) {
    logFailureSafely({
      status: 'missing_exact_attempt',
      batch_id: job.data.batch_id,
      business_id: job.data.business_id,
      error_class: errorClass,
    });
    return;
  }

  let ownsAttempt = false;
  let parentTerminalized = false;
  try {
    await sql.begin(async (tx) => {
      // Coupled terminal transition: ownership CAS FIRST. Do not add a query
      // or lock above this statement.
      ownsAttempt = await markOutboxFailed(
        tx,
        outboxId,
        `build_solicitation_batch_exhausted:${errorClass}`,
        attempt,
      );
      if (!ownsAttempt) return;

      const [activeParent] = await tx<{ id: string }[]>`
        SELECT parent.id
        FROM solicitation_batches batch
        JOIN agent_runs parent
          ON parent.account_id = batch.account_id
         AND parent.business_id = batch.business_id
         AND parent.kind = 'solicitation_batch'
         AND parent.subject_type = 'solicitation_batch'
         AND parent.subject_id = batch.id::text
         AND parent.status = 'running'
        WHERE batch.id = ${job.data.batch_id}::uuid
          AND batch.business_id = ${job.data.business_id}::uuid
          AND parent.business_id = ${job.data.business_id}::uuid
          AND batch.built_at IS NULL
        FOR UPDATE OF batch, parent
      `;
      if (!activeParent) return;

      await failSolicitationBatchRun(tx, {
        runId: activeParent.id,
        failure: {
          code: 'build_failed',
          errorClass,
        },
      });
      parentTerminalized = true;
    });
  } catch (handlerErr) {
    // A failed coupled transaction rolls both writes back. Leave the outbox
    // dispatched for watchdog recovery; never split the transition here.
    logFailureSafely({
      status: 'terminal_checkpoint_failed',
      batch_id: job.data.batch_id,
      business_id: job.data.business_id,
      outbox_attempt: attempt,
      error_class: boundedErrorClass(handlerErr),
    });
    return;
  }

  logFailureSafely({
    status: ownsAttempt ? 'terminalized' : 'stale',
    batch_id: job.data.batch_id,
    business_id: job.data.business_id,
    outbox_attempt: attempt,
    error_class: errorClass,
    parent_terminalized: parentTerminalized,
  });
}
