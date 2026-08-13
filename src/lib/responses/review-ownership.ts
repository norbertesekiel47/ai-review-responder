import type postgres from 'postgres';

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export async function proveReviewOwnership(
  db: SqlExecutor,
  reviewId: string,
  accountId: string,
): Promise<string | null> {
  const rows = await db<{ business_id: string }[]>`
    SELECT rv.business_id
    FROM reviews rv
    JOIN businesses b ON b.id = rv.business_id
    WHERE rv.id = ${reviewId}::uuid
      AND b.account_id = ${accountId}::uuid
      AND b.archived_at IS NULL
    LIMIT 1
  `;
  return rows[0]?.business_id ?? null;
}
