import { sql } from '@/lib/db/server';

/**
 * Marks an outbox entry as completed. Used by every worker on the
 * success path when the work is done outside a transaction.
 *
 * For outbox completion INSIDE a sql.begin() transaction, use inline
 * tx SQL instead — this function uses the standalone sql client.
 */
export async function markOutboxCompleted(outboxId: string): Promise<void> {
  await sql`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW()
    WHERE id = ${outboxId}
  `;
}

/**
 * Marks an outbox entry as terminally failed. The entry will NOT be
 * retried by the OutboxPoller.
 */
export async function markOutboxFailed(
  outboxId: string,
  error: string,
): Promise<void> {
  await sql`
    UPDATE job_outbox
    SET status = 'failed', last_error = ${error}, completed_at = NOW()
    WHERE id = ${outboxId}
  `;
}
