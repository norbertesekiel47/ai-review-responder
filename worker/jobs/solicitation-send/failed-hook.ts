// The `'failed'` exhaustion hook for the Solicitation send worker (#899).
//
// Colocated with its worker (CLAUDE.md worker layout: a `'failed'` exhaustion
// hook lives beside the job it terminalizes), and shaped after
// `worker/jobs/solicitation-batch/failed-hook.ts`: a named module owns the
// coupled transaction, the exported handler orchestrates and maps errors
// (invariant #12).
//
// It is the ONLY writer of `send_exhausted`. `dispatch.ts` owns `send_failed`
// — the provider answered and the answer was terminal — and this hook owns the
// other half: BullMQ ran out of attempts, so the dispatch never got an answer
// at all. Migration 091's status/reason CHECK carries both.
//
// PII contract: this lane's subject, body, recipient handle and unsubscribe
// token never reach it, and nothing here logs anything but ids, an error CLASS
// and closed enum values.

import type { Job } from 'bullmq';
import type { Sql, TransactionSql } from 'postgres';
import { completeRun } from '@/lib/agents/run-spine';
import { acquireSolicitationBatchLock } from '@/lib/solicitation/batch-builder';
import { closeBatchIfSettled } from '@/lib/solicitation/outreach';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle, markOutboxFailed } from '@/lib/shared/outbox';
import type { SolicitationSendPayload } from '@/lib/shared/worker-types';

const logger = createWorkerLogger('[SolicitationSendWorker.failed]');

/** The one reason this hook writes. 091 pairs `failed` with exactly
 *  `send_failed` (dispatch.ts's tx2) and this one. */
const SEND_EXHAUSTED_REASON = 'send_exhausted';

/**
 * A constructor name safe to put in a log field: bounded length, strict
 * identifier shape. Local rather than imported from
 * `worker/jobs/solicitation-batch/failed-hook-shared.ts`, whose docstring binds
 * it to that folder ("Deliberately NOT generalized past this folder") — the
 * judge hook keeps its own copy for the same reason.
 */
function boundedErrorClass(err: unknown): string {
  if (!(err instanceof Error)) return 'UnknownError';
  const constructorName = err.constructor.name;
  return /^[A-Za-z][A-Za-z0-9_$]{0,99}$/.test(constructorName)
    ? constructorName
    : 'UnknownError';
}

function isSendAttemptExhausted(job: Job<SolicitationSendPayload>): boolean {
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
    ? job.opts.attempts
    : 1;
  // Terminal-attempt check for the BullMQ 'failed' EVENT context: the Worker
  // emits 'failed' only after job.moveToFailed() has incremented attemptsMade
  // to include the failing attempt, so with attempts=3 only 3/3 is terminal
  // (2/3 still has a retry). The shared isTerminalAttempt
  // (src/lib/shared/outbox.ts) answers the same question INSIDE a processor
  // catch block, where attemptsMade has NOT yet been incremented — hence its
  // `attemptsMade + 1 >= maxAttempts`. Both are correct in their own call
  // context; do not unify them.
  return job.attemptsMade >= maxAttempts;
}

/**
 * Observability only, and it must never escape a bare BullMQ `failed`
 * listener — a throw there is an unhandled rejection, not a retry.
 */
function logFailureSafely(details: Record<string, string | number | boolean>): void {
  try {
    logger.error('solicitation send exhausted', details);
  } catch {
    // See above: observability must not poison the hook.
  }
}

interface ExhaustedOutreachRow {
  /** Resolved from the ROW, never from the payload: the composite FK binds
   *  (business_id, account_id), so a payload-supplied account id would be an
   *  unverified claim from a producer this module does not own. */
  account_id: string;
  /** The **Lazy child** tx1 created, or NULL when the attempt died above it. */
  agent_run_id: string | null;
  delivery_status: string;
}

interface SendExhaustionOutcome {
  ownsAttempt: boolean;
  terminalized: boolean;
  childFailed: boolean;
  /** Why nothing was terminalized, for the log line. */
  status: 'terminalized' | 'stale' | 'vanished' | 'already_terminal';
}

interface SendExhaustionHandle {
  batchId: string;
  businessId: string;
  outreachId: string;
  outboxId: string;
  attempt: number;
}

/**
 * The whole dead-letter, committed or rolled back as one unit: the outbox
 * ownership CAS, the `failed` / `send_exhausted` terminal, the **Lazy child**'s
 * terminal and the `closeBatchIfSettled` join.
 *
 * THE ADVISORY LOCK IS THE FIRST STATEMENT, exactly as it is in `dispatch.ts`'s
 * tx1 and tx2: the offboarding purge takes this key and THEN row-locks
 * (cascades into) `solicitation_outreach`, so a transaction that row-locked the
 * Outreach row first and then waited for the batch row would be an ABBA
 * deadlock against it (`acquireSolicitationBatchLock`'s docstring owns that
 * contract; `worker/jobs/account-offboarding/purge-stages.ts` is the other half).
 *
 * The ownership CAS comes next, before any domain write: a stale hook — one
 * whose attempt the watchdog already superseded — writes NOTHING, so it can
 * never terminalize a row a newer attempt is still dispatching.
 *
 * `closeBatchIfSettled` runs only when THIS hook terminalized the row. A row
 * some other writer already terminalized was joined by that writer in its own
 * transaction, and a **Settled batch** joined twice is a duplicate receipt step.
 */
async function commitSendExhaustion(
  sql: Sql,
  handle: SendExhaustionHandle,
  errorClass: string,
): Promise<SendExhaustionOutcome> {
  const outcome: SendExhaustionOutcome = {
    ownsAttempt: false,
    terminalized: false,
    childFailed: false,
    status: 'stale',
  };

  await sql.begin(async (tx: TransactionSql) => {
    await acquireSolicitationBatchLock(tx, handle.businessId);

    outcome.ownsAttempt = await markOutboxFailed(
      tx,
      handle.outboxId,
      `solicitation_send_exhausted:${errorClass}`,
      handle.attempt,
    );
    if (!outcome.ownsAttempt) return;

    const [row] = await tx<ExhaustedOutreachRow[]>`
      SELECT account_id, agent_run_id, delivery_status
      FROM solicitation_outreach
      WHERE id = ${handle.outreachId}::uuid
        AND business_id = ${handle.businessId}::uuid
        AND batch_id = ${handle.batchId}::uuid
      FOR UPDATE
    `;
    if (!row) {
      // Gone under the lock — an offboarding purge landing mid-flight. The
      // attempt is spent above; there is nothing left to terminalize or join.
      outcome.status = 'vanished';
      return;
    }

    // `('queued', 'sending')` and nothing else: those are the two live statuses
    // a dispatched job can leave behind — `queued` when the attempt died above
    // tx1's CAS, `sending` when it died after it. `rendered` is deliberately
    // absent (that row was never dispatched, and 091's status/timestamp CHECK
    // would then record a dispatch that never happened), and so is every
    // terminal status, which belongs to whichever writer got there first.
    const terminalized = await tx<{ id: string }[]>`
      UPDATE solicitation_outreach
      SET delivery_status = 'failed',
          disposition_reason = ${SEND_EXHAUSTED_REASON},
          updated_at = NOW()
      WHERE id = ${handle.outreachId}::uuid
        AND account_id = ${row.account_id}::uuid
        AND business_id = ${handle.businessId}::uuid
        AND delivery_status IN ('queued', 'sending')
      RETURNING id
    `;
    if (terminalized.count === 0) {
      // Another writer owns the row's final status — tx2 landing after the
      // last attempt threw, or #900's D12d sweep calling it `unknown`. Its
      // verdict STANDS, and it already joined the batch.
      outcome.status = 'already_terminal';
      return;
    }
    outcome.terminalized = true;
    outcome.status = 'terminalized';

    if (row.agent_run_id !== null) {
      // Decision 8's failure arm: a dispatch that never got a provider answer
      // is a failure to send. A NULL run means the attempt died above tx1 and
      // no child was ever created — there is nothing to terminalize, and
      // creating one here would record work this hook did not perform.
      await completeRun(tx, row.agent_run_id, 'failed', {
        failure_class: 'send_exhausted',
        error_class: errorClass,
      });
      outcome.childFailed = true;
    }

    // A **Settled batch** has no Outreach row left in `rendered`, `queued` or
    // `sending`. An exhausted row that never joined would leave the batch open
    // forever and permanently consume the account's one active-batch slot.
    await closeBatchIfSettled(tx, {
      batchId: handle.batchId,
      accountId: row.account_id,
      businessId: handle.businessId,
    });
  });

  return outcome;
}

/**
 * Exhausted-attempt terminalizer for `solicitation_send`.
 *
 * Fires on the FINAL BullMQ attempt and on no other: before it, the job still
 * belongs to BullMQ, and terminalizing early would write `failed` on a row a
 * later attempt is still allowed to dispatch — with a stable provider
 * idempotency key, a "failed" row whose message may yet be delivered.
 */
export async function handleSolicitationSendFailed(
  sql: Sql,
  job: Job<SolicitationSendPayload> | undefined,
  err: unknown,
): Promise<void> {
  if (!job || !isSendAttemptExhausted(job)) return;

  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
  const errorClass = boundedErrorClass(err);
  const jobFields = {
    batch_id: job.data.batch_id,
    business_id: job.data.business_id,
    outreach_id: job.data.outreach_id,
  };

  if (attempt === undefined) {
    // Without an exact attempt the ownership CAS is unguarded, and an
    // unguarded terminal can stomp a newer attempt's row. Precedent:
    // `solicitation-batch/failed-hook.ts`'s `missing_exact_attempt` arm.
    logFailureSafely({ status: 'missing_exact_attempt', ...jobFields, error_class: errorClass });
    return;
  }

  let outcome: SendExhaustionOutcome;
  try {
    outcome = await commitSendExhaustion(
      sql,
      {
        batchId: job.data.batch_id,
        businessId: job.data.business_id,
        outreachId: job.data.outreach_id,
        outboxId,
        attempt,
      },
      errorClass,
    );
  } catch (hookErr) {
    // The coupled transaction rolled back as a unit, so the outbox row is
    // still `dispatched` and the watchdog can reclaim it. Never split the
    // terminal checkpoint by retrying half of it here.
    logFailureSafely({
      status: 'terminal_checkpoint_failed',
      ...jobFields,
      outbox_attempt: attempt,
      error_class: boundedErrorClass(hookErr),
    });
    return;
  }

  logFailureSafely({
    status: outcome.status,
    ...jobFields,
    outbox_attempt: attempt,
    error_class: errorClass,
    child_failed: outcome.childFailed,
  });
}
