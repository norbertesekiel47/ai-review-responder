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
// "NEVER GOT AN ANSWER" IS TWO DIFFERENT FACTS, AND THIS HOOK MUST NOT CONFLATE
// THEM. The arrival status says which one happened:
//
//   * `queued` — the attempt died ABOVE tx1's CAS, so nothing was ever put on
//     the wire. `failed` / `send_exhausted` is the honest reading.
//   * `sending` — the attempt died AFTER tx1 claimed the row, so the message
//     may already have reached the recipient and no one here can tell.
//     `unknown` / `send_indeterminate` is the honest reading, and it is why
//     D12d minted that pair in the first place.
//
// Writing `failed` for a `sending` row is D12d's named lie-with-teeth: the
// restraint policy's `over_contacted` check counts PRIOR SENDS, so a possible
// send recorded as "not sent" puts that customer back in a future batch and
// emails them twice. This hook therefore shares `send_indeterminate` with
// #900's D12d sweep rather than owning it — the sweep terminalizes a `sending`
// row that timed out, this hook terminalizes one whose job ladder ran out, and
// both are making the same claim about the same unknowable fact.
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
// Log-field hygiene only, and the one helper in that file with no lane-specific
// semantics: it turns a constructor name into a bounded identifier and makes no
// claim about transport errors or exhaustion arithmetic, which is what its
// "deliberately NOT generalized past this folder" docstring is actually about.
// `isSendAttemptExhausted` below stays local for exactly that reason.
import { boundedErrorClass } from '../solicitation-batch/failed-hook-shared';

const logger = createWorkerLogger('[SolicitationSendWorker.failed]');

/**
 * The two status/reason pairs this hook writes, keyed by the status the row
 * arrived in. Both are legal under 091's `solicitation_outreach_status_reason_
 * consistency` CHECK as re-stated by 110, so this split needs no migration.
 *
 * `childStatus` is `failed` on BOTH arms, and deliberately so. `agent_runs`
 * carries no `unknown` (091: running/completed/cancelled/failed), and of the
 * three terminals only `failed` is true of an indeterminate dispatch: the RUN
 * did not finish the work it started, whatever the provider did with the bytes.
 * `completed` would assert a send this hook cannot witness and `cancelled`
 * would assert a decision nobody made. The indeterminacy lives in
 * `failure_class`, and the Outreach row — not the run — is the authoritative
 * record of whether a customer may have been contacted.
 */
const TERMINAL_BY_ARRIVAL = {
  queued: {
    deliveryStatus: 'failed',
    dispositionReason: 'send_exhausted',
    childStatus: 'failed',
    failureClass: 'send_exhausted',
  },
  sending: {
    deliveryStatus: 'unknown',
    dispositionReason: 'send_indeterminate',
    childStatus: 'failed',
    failureClass: 'send_indeterminate',
  },
} as const;

type TerminalArrivalStatus = keyof typeof TERMINAL_BY_ARRIVAL;

/** The two live statuses a dispatched job can leave behind. `rendered` is
 *  deliberately absent (that row was never dispatched, and 091's
 *  status/timestamp CHECK would then record a dispatch that never happened),
 *  and so is every terminal status, which belongs to whichever writer got
 *  there first. */
function isTerminalizableArrival(status: string): status is TerminalArrivalStatus {
  return status === 'queued' || status === 'sending';
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
  /** WHICH terminal was written, so an operator can tell the honest-failure arm
   *  from the indeterminate one without re-reading the row. Null when nothing
   *  was terminalized. */
  deliveryStatus: string | null;
  dispositionReason: string | null;
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
    deliveryStatus: null,
    dispositionReason: null,
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

    if (!isTerminalizableArrival(row.delivery_status)) {
      // Another writer owns the row's final status — tx2 landing after the
      // last attempt threw, or #900's D12d sweep calling it `unknown`. Its
      // verdict STANDS, and it already joined the batch.
      outcome.status = 'already_terminal';
      return;
    }

    // THE ARRIVAL STATUS PICKS THE TERMINAL — see the module header. Read under
    // the `FOR UPDATE` above, so the CAS below re-asserts the exact value this
    // arm was chosen for rather than a two-member `IN` list: a predicate that
    // admitted both would let a row that moved `queued → sending` under us take
    // the `failed` verdict computed for the status it no longer has.
    const terminal = TERMINAL_BY_ARRIVAL[row.delivery_status];

    const terminalized = await tx<{ id: string }[]>`
      UPDATE solicitation_outreach
      SET delivery_status = ${terminal.deliveryStatus},
          disposition_reason = ${terminal.dispositionReason},
          updated_at = NOW()
      WHERE id = ${handle.outreachId}::uuid
        AND account_id = ${row.account_id}::uuid
        AND business_id = ${handle.businessId}::uuid
        AND delivery_status = ${row.delivery_status}
      RETURNING id
    `;
    if (terminalized.count === 0) {
      outcome.status = 'already_terminal';
      return;
    }
    outcome.terminalized = true;
    outcome.status = 'terminalized';
    outcome.deliveryStatus = terminal.deliveryStatus;
    outcome.dispositionReason = terminal.dispositionReason;

    if (row.agent_run_id !== null) {
      // Decision 8's failure arm: a dispatch that never got a provider answer
      // is a failure to send — and one that MAY have sent is still a run that
      // did not finish its work, so both arms terminalize `failed` and differ
      // only in the `failure_class` they record. A NULL run means the attempt
      // died above tx1 and no child was ever created — there is nothing to
      // terminalize, and creating one here would record work this hook did not
      // perform.
      await completeRun(tx, row.agent_run_id, terminal.childStatus, {
        failure_class: terminal.failureClass,
        error_class: errorClass,
      });
      outcome.childFailed = true;
    }

    // A **Settled batch** has no Outreach row left in `rendered`, `queued` or
    // `sending`. An exhausted row that never joined would leave the batch open
    // forever and permanently consume the account's one active-batch slot.
    // `unknown` settles a batch exactly as `failed` does — it is terminal, and
    // the fact it records is "we will never know", not "we are still trying".
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
 * belongs to BullMQ, and terminalizing early would write a terminal status on a
 * row a later attempt is still allowed to dispatch — with a stable provider
 * idempotency key, a terminalized row whose message may yet be delivered.
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
    // Which of the two honest terminals was written. A run of
    // `send_indeterminate` is the signal that dispatches are dying between the
    // CAS and the provider answer, which is a different operational problem
    // from a run of `send_exhausted`.
    delivery_status: outcome.deliveryStatus ?? 'none',
    disposition_reason: outcome.dispositionReason ?? 'none',
  });
}
