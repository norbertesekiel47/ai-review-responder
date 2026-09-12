import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { TURN_FAILURE_REASON } from '@/lib/agents/operator/schema';
import { failTurnIfNonTerminal } from '@/lib/agents/operator/turns';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle, markOutboxFailed } from '@/lib/shared/outbox';
import type { AgentTurnPayload } from '@/lib/shared/worker-types';

const logger = createWorkerLogger('[AgentTurnWorker.failed]');

/**
 * Terminal-attempt check for the BullMQ 'failed' EVENT context: the Worker
 * emits 'failed' only after moveToFailed() incremented attemptsMade to include
 * the failing attempt, so with attempts=5 only 5/5 is terminal. Deliberately
 * NOT the shared isTerminalAttempt (src/lib/shared/outbox.ts:211), which
 * answers the same question inside a processor catch where attemptsMade has not
 * yet been incremented. Both are correct in their own context; do not unify.
 */
function isExhausted(job: Job<AgentTurnPayload>): boolean {
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
    ? job.opts.attempts
    : 1;
  return job.attemptsMade >= maxAttempts;
}

function boundedErrorClass(err: unknown): string {
  return err instanceof Error && err.name ? err.name.slice(0, 100) : 'UnknownError';
}

export async function handleAgentTurnFailed(
  sql: Sql,
  job: Job<AgentTurnPayload> | undefined,
  err: unknown,
): Promise<void> {
  if (!job || !isExhausted(job)) return;

  try {
    const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
    const errorClass = boundedErrorClass(err);
    // ONE TRANSACTION, and the ORDER inside it is the whole point.
    //
    // `markOutboxFailed` matches only a row still `dispatched` at exactly this
    // attempt, so it answers the question that has to come first: is this
    // exhausted dispatch still the row's owner? It often is not — the watchdog
    // may have re-pended and re-dispatched while this job burned its last
    // retry, so a NEWER attempt can be running, or may already have completed
    // the turn. Failing the turn without asking would kill that live attempt's
    // work from a job that lost ownership minutes ago.
    //
    // Both statements share one `begin` so the pair cannot half-apply: an
    // earlier draft failed the outbox row on its own connection and then the
    // turn on another, which on a crash between them left the row terminal and
    // the turn `running` — invisible to the watchdog, because the row it would
    // have reclaimed was already failed.
    await sql.begin(async (tx) => {
      const owns = await markOutboxFailed(
        tx,
        outboxId,
        `agent_turn_exhausted:${errorClass}`,
        attempt,
      );
      if (!owns) {
        logger.log('agent_turn exhaustion for a superseded dispatch, leaving the turn alone', {
          turn_id: job.data.turn_id,
        });
        return;
      }
      // The row is already terminal in this transaction, so the turn
      // transition writes no outbox statement of its own.
      await failTurnIfNonTerminal(tx, {
        turnId: job.data.turn_id,
        accountId: job.data.account_id,
        reason: TURN_FAILURE_REASON.EXHAUSTED,
      });
    });
  } catch (handlerError) {
    // The transaction rolled back as a unit, so the outbox row stays
    // dispatched and the watchdog can reclaim it. Never log owner text or the
    // error message — only the bounded class.
    logger.error('Terminal agent_turn checkpoint failed', {
      error_name: handlerError instanceof Error ? handlerError.name : 'unknown',
      turn_id: job.data.turn_id,
    });
  }
}
