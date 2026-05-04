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
    logger.warn(`Demo ${demoId} already claimed (${table}), completing outbox`);
    return 'already_terminal';
  }

  return 'claimed';
}

/**
 * Completes a demo row + outbox in a single transaction.
 *
 * For `onboarding_demos`, the `source` parameter is REQUIRED and written to
 * the `source` column. For `prospect_demos`, the parameter is omitted and the
 * default `'serpapi'` remains untouched (the column has `DEFAULT 'serpapi'`).
 *
 * Race semantics (onboarding_demos only):
 *   The partial unique index `(user_id WHERE generation_status='completed')`
 *   fires when this UPDATE sets status='completed'. If a concurrent worker
 *   already completed a different row for the same user, Postgres throws
 *   23505. We catch it, archive THIS row (race-loser), and complete the
 *   outbox cleanly.
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

  try {
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
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (isOnboarding && code === '23505') {
      // 23505 unique_violation — partial unique on onboarding_demos(user_id) WHERE completed.
      // Find the winner row and archive this loser.
      const [loser] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM onboarding_demos WHERE id = ${demoId}
      `;
      if (loser) {
        const [winner] = await sql<{ id: string }[]>`
          SELECT id FROM onboarding_demos
          WHERE user_id = ${loser.user_id} AND generation_status = 'completed'
          LIMIT 1
        `;
        if (winner) {
          await sql`
            UPDATE onboarding_demos
            SET generation_status = 'archived', updated_at = NOW()
            WHERE id = ${demoId}
          `;
          await sql`
            UPDATE job_outbox
            SET status = 'completed', completed_at = NOW()
            WHERE id = ${outboxId}
              AND status = 'dispatched'
          `;
          return;
        }
      }
    }
    throw err;
  }
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
