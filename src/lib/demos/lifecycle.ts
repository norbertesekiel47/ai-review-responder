import type { Sql } from 'postgres';
import { markOutboxCompleted } from '@/lib/shared/outbox';
import type { WorkerLogger } from '@/lib/shared/logger';
import type { DemoTable, ClaimResult, CompleteDemoArgs } from './types';

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Claims a demo row for processing: queued → running, with stale-running recovery.
 *
 * @returns
 *   'claimed'           — row transitioned to running, safe to proceed
 *   'already_terminal'  — row is completed, failed, or archived; outbox must be closed
 *   'not_found'         — row does not exist; outbox must be closed
 *   'reset_to_queued'   — row was stuck in running >5min and was reset; caller should
 *                         re-throw so BullMQ re-dispatches
 *
 * @throws if the row is `running` and NOT stale (active worker, retry later)
 */
export async function claimDemo(
  sql: Sql,
  table: DemoTable,
  demoId: string,
  logger: WorkerLogger,
): Promise<ClaimResult> {
  const [demo] = await sql<{ generation_status: string; started_at: Date | null }[]>`
    SELECT generation_status, started_at FROM ${sql(table)} WHERE id = ${demoId}
  `;

  if (!demo) {
    logger.warn(`Demo ${demoId} not found (${table}), completing outbox`);
    return 'not_found';
  }

  if (
    demo.generation_status === 'completed' ||
    demo.generation_status === 'failed' ||
    demo.generation_status === 'archived'
  ) {
    logger.warn(`Demo ${demoId} already ${demo.generation_status} (${table}), completing outbox`);
    return 'already_terminal';
  }

  if (
    demo.generation_status === 'running' &&
    demo.started_at &&
    Date.now() - new Date(demo.started_at).getTime() > STALE_THRESHOLD_MS
  ) {
    logger.warn(`Demo ${demoId} stuck in running >5min (${table}), resetting to queued`);
    await sql`
      UPDATE ${sql(table)}
      SET generation_status = 'queued', started_at = NULL
      WHERE id = ${demoId} AND generation_status = 'running'
    `;
    // CALLER CONTRACT: callers MUST throw an Error after observing this return
    // value so BullMQ re-dispatches the job. Silent fall-through leaves the row
    // in 'queued' until OutboxPoller's heartbeat picks it up — recoverable but
    // adds latency. The worker (worker/jobs/DemoGenerationWorker.ts) handles
    // this by throwing inside its `if (claimResult === 'reset_to_queued')` branch.
    return 'reset_to_queued';
  }

  if (demo.generation_status === 'running') {
    throw new Error(
      `Demo ${demoId} is running (${table}, started ${demo.started_at?.toISOString()}), retrying later`,
    );
  }

  // queued → running (race-safe CAS)
  const updated = await sql`
    UPDATE ${sql(table)}
    SET generation_status = 'running', started_at = NOW()
    WHERE id = ${demoId} AND generation_status = 'queued'
  `;

  if (updated.count === 0) {
    // Lost the queued → running CAS race. The row is no longer `queued`, but
    // we don't know whether it's `running` (another worker is processing) or
    // already terminal. Caller treats this the same as `already_terminal`
    // (drop the job, mark outbox complete).
    logger.warn(`Demo ${demoId} race_lost on claim CAS (${table}), completing outbox`);
    return 'race_lost';
  }

  return 'claimed';
}

/**
 * Completes a demo row + outbox in a single transaction.
 *
 * For `onboarding_demos`, the `source` parameter is REQUIRED and written to
 * the `source` column. For `prospect_demos`, the `source` parameter is omitted
 * entirely. That table has no `source` column — it has its own
 * `review_source TEXT NOT NULL DEFAULT 'serpapi'` populated at INSERT time by
 * the prospect-demo creation path. We never touch it here.
 *
 * PR #2 race-loser handling: implemented in the catch arm below. When the
 * partial unique index `onboarding_demos_one_completed_per_user` rejects the
 * loser of a concurrent regenerate (Postgres 23505), we archive THIS row and
 * close the outbox cleanly in a single tx — preserving the winning demo as
 * the most-recent row the demo page renders.
 */
export async function completeDemo(
  sql: Sql,
  table: DemoTable,
  demoId: string,
  outboxId: string,
  outboxAttempt: number | undefined,
  result: CompleteDemoArgs,
): Promise<void> {
  const { reviews, responses, source } = result;
  const isOnboarding = table === 'onboarding_demos';

  try {
    await sql.begin(async (tx) => {
      if (isOnboarding && source) {
        await tx`
          UPDATE ${tx(table)}
          SET reviews_snapshot = ${tx.json(reviews as never)},
              generated_responses = ${tx.json(responses as never)},
              generation_status = 'completed',
              completed_at = NOW(),
              source = ${source}
          WHERE id = ${demoId}
        `;
      } else {
        await tx`
          UPDATE ${tx(table)}
          SET reviews_snapshot = ${tx.json(reviews as never)},
              generated_responses = ${tx.json(responses as never)},
              generation_status = 'completed',
              completed_at = NOW()
          WHERE id = ${demoId}
        `;
      }

      await markOutboxCompleted(tx, outboxId, outboxAttempt);
    });
  } catch (err) {
    // 23505 race-loser recovery for onboarding_demos. The partial unique
    // index `onboarding_demos_one_completed_per_user` (migration 032) blocks
    // concurrent completes for the same user. The loser must archive itself
    // and close its outbox cleanly; otherwise the failed loser becomes the
    // most-recent row and the demo page renders failure instead of the
    // winning completed demo.
    //
    // Single tx: archive + outbox close are atomic together. If we ran them
    // outside a tx and the outbox close failed, the OutboxPoller would
    // re-dispatch the job, loop here, hit 23505 again, recover archived
    // (no-op) — recoverable but adds unnecessary churn.
    const code = (err as { code?: string } | null)?.code;
    if (table === 'onboarding_demos' && code === '23505') {
      await sql.begin(async (tx) => {
        await tx`
          UPDATE onboarding_demos
          SET generation_status = 'archived',
              updated_at = NOW()
          WHERE id = ${demoId}
        `;

        await markOutboxCompleted(tx, outboxId, outboxAttempt);
      });
      return;
    }
    throw err;
  }
}

/**
 * Fails a demo row + outbox in a single transaction.
 */
export async function failDemo(
  sql: Sql,
  table: DemoTable,
  demoId: string,
  outboxId: string,
  outboxAttempt: number | undefined,
  error: Error,
): Promise<void> {
  const message = error.message;

  await sql.begin(async (tx) => {
    await tx`
      UPDATE ${tx(table)}
      SET generation_status = 'failed',
          generation_error = ${message},
          completed_at = NOW()
      WHERE id = ${demoId}
    `;

    if (typeof outboxAttempt === 'number') {
      await tx`
        UPDATE job_outbox
        SET status = 'failed', last_error = ${message}, completed_at = NOW()
        WHERE id = ${outboxId}
          AND status = 'dispatched'
          AND attempts = ${outboxAttempt}
      `;
    } else {
      await tx`
        UPDATE job_outbox
        SET status = 'failed', last_error = ${message}, completed_at = NOW()
        WHERE id = ${outboxId}
          AND status = 'dispatched'
      `;
    }
  });
}
