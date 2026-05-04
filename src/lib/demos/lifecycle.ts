import { sql, jsonb } from '@/lib/db/server';
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
 * PR #2 NOTE — race-loser handling (deferred):
 *   Once `onboarding_demos` ships with the partial unique index
 *   `(user_id WHERE generation_status='completed')`, two concurrent completes
 *   for the same user_id will trip 23505 here. PR #2 must add a catch arm that:
 *     1. Confirms `table === 'onboarding_demos' && err.code === '23505'`
 *     2. In a SINGLE `sql.begin` tx (atomicity matters — non-atomic recovery
 *        leaves implicit dependence on `claimDemo`'s `already_terminal` path):
 *        a. Look up the winning row (same user_id, status='completed')
 *        b. Archive THIS row (status='archived', updated_at=NOW())
 *        c. Mark outbox completed
 *     3. Add an integration test exercising two concurrent completes
 *   Adding the recovery path before the table exists would be speculative
 *   abstraction — column-name typos would only surface at PR #2 integration,
 *   defeating the "extract first, consume later" guard.
 */
export async function completeDemo(
  table: DemoTable,
  demoId: string,
  outboxId: string,
  outboxAttempt: number | undefined,
  result: CompleteDemoArgs,
): Promise<void> {
  const { reviews, responses, source } = result;
  const isOnboarding = table === 'onboarding_demos';

  await sql.begin(async (tx) => {
    if (isOnboarding && source) {
      await tx`
        UPDATE ${tx(table)}
        SET reviews_snapshot = ${jsonb(reviews)},
            generated_responses = ${jsonb(responses)},
            generation_status = 'completed',
            completed_at = NOW(),
            source = ${source}
        WHERE id = ${demoId}
      `;
    } else {
      await tx`
        UPDATE ${tx(table)}
        SET reviews_snapshot = ${jsonb(reviews)},
            generated_responses = ${jsonb(responses)},
            generation_status = 'completed',
            completed_at = NOW()
        WHERE id = ${demoId}
      `;
    }

    if (typeof outboxAttempt === 'number') {
      await tx`
        UPDATE job_outbox
        SET status = 'completed', completed_at = NOW()
        WHERE id = ${outboxId}
          AND status = 'dispatched'
          AND attempts = ${outboxAttempt}
      `;
    } else {
      await tx`
        UPDATE job_outbox
        SET status = 'completed', completed_at = NOW()
        WHERE id = ${outboxId}
          AND status = 'dispatched'
      `;
    }
  });
}

/**
 * Fails a demo row + outbox in a single transaction.
 */
export async function failDemo(
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
