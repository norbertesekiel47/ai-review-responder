import type { TransactionSql } from 'postgres';

export class AutonomyAccountNotFoundError extends Error {
  constructor(public readonly accountId: string) {
    super('autonomy account does not exist');
    this.name = 'AutonomyAccountNotFoundError';
  }
}

/**
 * Serializes every autonomy suspension transition on a guaranteed parent row.
 * Mixed review-lane callers must acquire review/business/child locks first;
 * governor and admin callers never acquire review-lane locks.
 */
export async function lockAutonomyAccount(
  tx: TransactionSql,
  accountId: string,
): Promise<void> {
  const [account] = await tx<{ id: string }[]>`
    SELECT id
    FROM accounts
    WHERE id = ${accountId}::uuid
    FOR UPDATE
  `;
  if (!account) throw new AutonomyAccountNotFoundError(accountId);
}
