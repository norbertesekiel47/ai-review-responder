import type { Job } from 'bullmq';
import type postgres from 'postgres';
import type { OutboxCompletionReason } from './outbox-completion-reason';

/** Either the standalone `sql` client or an open `sql.begin()` transaction handle. */
type SqlExecutor = postgres.Sql | postgres.TransactionSql;

const hasAttempt = (attempt?: number): attempt is number =>
  typeof attempt === 'number' && Number.isFinite(attempt);

/**
 * WHERE predicate selecting the still-`dispatched` outbox row — attempt-guarded
 * when the dispatch attempt is known, so a stale worker that resolves AFTER the
 * watchdog re-dispatched the entry can't stomp the newer attempt's status. Built
 * with the caller's executor so it composes into both standalone-`sql` and
 * `sql.begin()` UPDATEs (Postgres.js inlines the nested fragment). One owner for
 * the guard that all three writers below share.
 */
const dispatchedRow = (exec: SqlExecutor, outboxId: string, attempt?: number) =>
  hasAttempt(attempt)
    ? exec`id = ${outboxId} AND status = 'dispatched' AND attempts = ${attempt}`
    : exec`id = ${outboxId} AND status = 'dispatched'`;

/**
 * Locks the exact still-dispatched outbox attempt inside the caller's open
 * transaction. A stale worker or terminal row returns false, allowing callers
 * to exit before mutating coupled domain state.
 */
export async function lockDispatchedOutboxAttemptIfOwned(
  exec: SqlExecutor,
  outboxId: string,
  attempt: number,
): Promise<boolean> {
  if (!hasAttempt(attempt)) return false;
  const rows = await exec<{ id: string }[]>`
    SELECT id FROM job_outbox
    WHERE ${dispatchedRow(exec, outboxId, attempt)}
    FOR UPDATE
  `;
  return rows.count > 0;
}

function warnOutboxNoop(label: string, outboxId: string, attempt: number): void {
  console.warn(
    `[outbox] ${label} no-op for ${outboxId} attempt=${attempt} — row already moved or attempt superseded`,
  );
}

/**
 * Extracts outbox_id and outbox_attempt from a BullMQ job payload.
 * Centralizes the `(job.data as unknown as { ... }).outbox_id ?? job.id`
 * idiom every worker uses. outbox_attempt is undefined for legacy BullMQ
 * jobs enqueued before the attempt-guard rollout, which degrades
 * gracefully to the unguarded UPDATE path.
 */
export function extractOutboxHandle(
  jobData: unknown,
  jobIdFallback: string,
): { outboxId: string; attempt: number | undefined } {
  const d = (jobData ?? {}) as { outbox_id?: unknown; outbox_attempt?: unknown };
  const outboxId = typeof d.outbox_id === 'string' ? d.outbox_id : jobIdFallback;
  const attempt = typeof d.outbox_attempt === 'number' && Number.isFinite(d.outbox_attempt)
    ? d.outbox_attempt
    : undefined;
  return { outboxId, attempt };
}

/**
 * Marks an outbox entry as completed. Used by every worker on the
 * success path when the work is done outside a transaction.
 *
 * `exec` is the caller's `sql` client for the common out-of-tx case, or an
 * open `sql.begin()` transaction handle to complete the entry INSIDE that
 * transaction — atomic with the state change it accompanies.
 *
 * `attempt` is the outbox_attempt the BullMQ job was dispatched under.
 * When provided, the UPDATE is attempt-guarded so a stale BullMQ worker
 * that resolves AFTER the watchdog has already re-dispatched the entry
 * cannot stomp the newer attempt's status. Workers pass
 * `job.data.outbox_attempt` (populated by OutboxPoller) when available;
 * legacy callers and tests that omit it behave as before.
 *
 * A 0-row UPDATE is logged and swallowed — this is the expected outcome
 * for the loser of an attempt race, not a bug.
 */
export async function markOutboxCompleted(
  exec: SqlExecutor,
  outboxId: string,
  attempt?: number,
): Promise<void> {
  await markOutboxCompletedIfOwned(exec, outboxId, attempt);
}

/**
 * Attempt-scoped completion CAS for callers that couple a durable domain write
 * to successful ownership of the dispatched outbox attempt. Call inside the
 * SAME transaction before the domain write: a later failure rolls completion
 * back with the domain mutation, while a stale attempt returns false and must
 * perform no mutation.
 */
export async function markOutboxCompletedIfOwned(
  exec: SqlExecutor,
  outboxId: string,
  attempt?: number,
): Promise<boolean> {
  const res = await exec`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW()
    WHERE ${dispatchedRow(exec, outboxId, attempt)}
  `;
  if (hasAttempt(attempt) && res.count === 0) {
    warnOutboxNoop('markOutboxCompleted', outboxId, attempt);
  }
  return res.count > 0;
}

/**
 * Marks an outbox entry completed with a DURABLE reason, so a row that finished
 * without doing its work is distinguishable by SQL from one that did.
 *
 * Generalized from `markOutboxOwnerUnreachable` at #695, when Import consent
 * refusals became the second reason. One method parameterized by the vocabulary,
 * rather than one method per reason: the latter grows the outbox seam's interface
 * forever while every body stays this same eleven-line CAS.
 *
 * Same attempt-guarded CAS as `markOutboxCompletedIfOwned` — a stale superseded
 * attempt no-ops (0 rows, logged and swallowed) rather than stamping a reason onto
 * a newer attempt's row. Idempotent re-marking on a later retry is expected;
 * downstream reads the LATEST completed reason, not the mere presence of one.
 *
 * Returns `void` deliberately: neither caller branches on the CAS result, and
 * `markOutboxCompletedIfOwned` already models the shape that does.
 */
export async function markOutboxCompletedWithReason(
  exec: SqlExecutor,
  outboxId: string,
  reason: OutboxCompletionReason,
  attempt?: number,
): Promise<void> {
  const res = await exec`
    UPDATE job_outbox
    SET status = 'completed',
        completed_at = NOW(),
        completion_reason = ${reason}
    WHERE ${dispatchedRow(exec, outboxId, attempt)}
  `;
  if (hasAttempt(attempt) && res.count === 0) {
    warnOutboxNoop(`markOutboxCompletedWithReason(${reason})`, outboxId, attempt);
  }
}

/**
 * Marks an outbox entry as terminally failed. The entry will NOT be
 * retried by the OutboxPoller. See markOutboxCompleted for attempt
 * semantics. Returns true only when this executor transitioned the matching
 * dispatched row; guarded stale attempts and missing legacy rows return false.
 * Callers that couple domain state to this transition must branch on the
 * result inside the same transaction.
 */
export async function markOutboxFailed(
  exec: SqlExecutor,
  outboxId: string,
  error: string,
  attempt?: number,
): Promise<boolean> {
  const res = await exec`
    UPDATE job_outbox
    SET status = 'failed', last_error = ${error}, completed_at = NOW()
    WHERE ${dispatchedRow(exec, outboxId, attempt)}
  `;
  if (hasAttempt(attempt) && res.count === 0) {
    warnOutboxNoop('markOutboxFailed', outboxId, attempt);
  }
  return res.count > 0;
}

/**
 * Surfaces a transient error on a still-'dispatched' outbox row WITHOUT
 * changing its status — the row remains eligible for BullMQ retries and the
 * watchdog. Best-effort by design: observability must never poison the retry
 * path, so any failure here is logged and swallowed.
 */
export async function recordOutboxTransientError(
  exec: SqlExecutor,
  outboxId: string,
  error: string,
  attempt?: number,
): Promise<void> {
  try {
    await exec`
      UPDATE job_outbox
      SET last_error = ${error}
      WHERE ${dispatchedRow(exec, outboxId, attempt)}
    `;
  } catch (recordErr) {
    console.warn(
      `[outbox] recordOutboxTransientError failed for ${outboxId} — observability only, swallowing: ${
        recordErr instanceof Error ? recordErr.message : String(recordErr)
      }`,
    );
  }
}

/**
 * True when the BullMQ job is on (or has exhausted) its final attempt — i.e. a
 * failure here is terminal and will not be retried. Reads only `opts.attempts`
 * (defaulting to 1 when unset/invalid) and `attemptsMade`. Worker `'failed'`
 * handlers use this to decide whether to alert + mark the outbox failed vs. let
 * BullMQ retry.
 */
export function isTerminalAttempt(job: Job<unknown>): boolean {
  const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
    ? job.opts.attempts
    : 1;
  return job.attemptsMade >= maxAttempts || job.attemptsMade + 1 >= maxAttempts;
}

/** Coerce an unknown thrown value to a string message without leaking a stack. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
