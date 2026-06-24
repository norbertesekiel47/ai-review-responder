import type { Job } from 'bullmq';
import type postgres from 'postgres';
import { sql } from '@/lib/db/server';

/** Either the standalone `sql` client or an open `sql.begin()` transaction handle. */
type SqlExecutor = typeof sql | postgres.TransactionSql;

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
 * Pass `exec` (a `sql.begin()` transaction handle) to complete the entry
 * INSIDE an open transaction — atomic with the state change it accompanies.
 * Defaults to the standalone `sql` client for the common out-of-tx case.
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
  outboxId: string,
  attempt?: number,
  exec: SqlExecutor = sql,
): Promise<void> {
  const res = await exec`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW()
    WHERE ${dispatchedRow(exec, outboxId, attempt)}
  `;
  if (hasAttempt(attempt) && res.count === 0) {
    warnOutboxNoop('markOutboxCompleted', outboxId, attempt);
  }
}

/**
 * Marks an outbox entry as terminally failed. The entry will NOT be
 * retried by the OutboxPoller. See markOutboxCompleted for attempt
 * semantics.
 */
export async function markOutboxFailed(
  outboxId: string,
  error: string,
  attempt?: number,
): Promise<void> {
  const res = await sql`
    UPDATE job_outbox
    SET status = 'failed', last_error = ${error}, completed_at = NOW()
    WHERE ${dispatchedRow(sql, outboxId, attempt)}
  `;
  if (hasAttempt(attempt) && res.count === 0) {
    warnOutboxNoop('markOutboxFailed', outboxId, attempt);
  }
}

/**
 * Surfaces a transient error on a still-'dispatched' outbox row WITHOUT
 * changing its status — the row remains eligible for BullMQ retries and the
 * watchdog. Best-effort by design: observability must never poison the retry
 * path, so any failure here is logged and swallowed.
 */
export async function recordOutboxTransientError(
  outboxId: string,
  error: string,
  attempt?: number,
): Promise<void> {
  try {
    await sql`
      UPDATE job_outbox
      SET last_error = ${error}
      WHERE ${dispatchedRow(sql, outboxId, attempt)}
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
