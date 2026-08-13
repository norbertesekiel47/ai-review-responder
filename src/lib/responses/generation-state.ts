import type postgres from 'postgres';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export async function pendingGenerateExists(
  db: SqlExecutor,
  reviewId: string,
): Promise<boolean> {
  const rows = await db<{ exists: number }[]>`
    SELECT 1 AS exists FROM job_outbox
    WHERE topic = ${QUEUE_NAMES.GENERATE_RESPONSE}
      AND aggregate_id = ${reviewId}
      AND status IN ('pending', 'dispatching', 'dispatched')
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Allocate the next version for a review whose row the caller already owns and
 * has locked. The same transaction must either insert the response or durably
 * reserve the version in an in-flight outbox row before releasing that lock.
 * The MAX query is intentionally separate from those writes; without the lock
 * and reservation invariant, concurrent callers could select the same version.
 */
export async function nextResponseVersion(
  db: postgres.TransactionSql,
  reviewId: string,
): Promise<number> {
  const rows = await db<{ next_version: number }[]>`
    SELECT COALESCE(MAX(version), 0) + 1 AS next_version
    FROM responses
    WHERE review_id = ${reviewId}::uuid
  `;
  return rows[0]?.next_version ?? 1;
}
