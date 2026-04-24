import { sql } from '@/lib/db/server';

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
 * For outbox completion INSIDE a sql.begin() transaction, use inline
 * tx SQL instead — this function uses the standalone sql client.
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
): Promise<void> {
  if (typeof attempt === 'number' && Number.isFinite(attempt)) {
    const res = await sql`
      UPDATE job_outbox
      SET status = 'completed', completed_at = NOW()
      WHERE id = ${outboxId}
        AND status = 'dispatched'
        AND attempts = ${attempt}
    `;
    if (res.count === 0) {
      console.warn(
        `[outbox] markOutboxCompleted no-op for ${outboxId} attempt=${attempt} — row already moved or attempt superseded`,
      );
    }
    return;
  }
  // Legacy path: attempt unknown. Still guard on status so a stale caller
  // can't regress a row that has already moved to 'failed' or 'completed'.
  await sql`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW()
    WHERE id = ${outboxId}
      AND status = 'dispatched'
  `;
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
  if (typeof attempt === 'number' && Number.isFinite(attempt)) {
    const res = await sql`
      UPDATE job_outbox
      SET status = 'failed', last_error = ${error}, completed_at = NOW()
      WHERE id = ${outboxId}
        AND status = 'dispatched'
        AND attempts = ${attempt}
    `;
    if (res.count === 0) {
      console.warn(
        `[outbox] markOutboxFailed no-op for ${outboxId} attempt=${attempt} — row already moved or attempt superseded`,
      );
    }
    return;
  }
  // Legacy path: attempt unknown. Still guard on status so a stale caller
  // can't regress a row that has already moved to 'failed' or 'completed'.
  await sql`
    UPDATE job_outbox
    SET status = 'failed', last_error = ${error}, completed_at = NOW()
    WHERE id = ${outboxId}
      AND status = 'dispatched'
  `;
}
