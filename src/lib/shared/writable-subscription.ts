import type postgres from 'postgres';
import { sql } from '@/lib/db/server';
import {
  computePastDueRecoveryState,
  type AccountFlagsInput,
  type PastDueRecoveryState,
} from './past-due-recovery';

export type WritableSubscriptionResult =
  | { ok: true }
  | { ok: false; status: 402; error: string };

type SubscriptionSql = postgres.Sql | postgres.TransactionSql;

export class SubscriptionReadOnlyError extends Error {
  readonly status = 402;

  constructor(readonly error = 'past_due_read_only') {
    super(error);
    this.name = 'SubscriptionReadOnlyError';
  }
}

export function assertWritableSubscription(
  recovery: PastDueRecoveryState,
): WritableSubscriptionResult {
  if (recovery.isReadOnly) {
    return { ok: false, status: 402, error: 'past_due_read_only' };
  }
  return { ok: true };
}

export async function assertWritableSubscriptionForAccount(
  accountId: string,
  db: SubscriptionSql = sql,
): Promise<WritableSubscriptionResult> {
  const [account] = await db<{
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  }[]>`
    SELECT subscription_status, past_due_at, flags
    FROM accounts
    WHERE id = ${accountId}::uuid
    LIMIT 1
  `;

  if (!account) {
    return { ok: true };
  }

  return assertWritableSubscription(computePastDueRecoveryState({
    subscriptionStatus: account.subscription_status,
    pastDueAt: account.past_due_at,
    accountFlags: account.flags,
  }));
}

export function throwIfReadOnly(result: WritableSubscriptionResult): void {
  if (!result.ok) {
    throw new SubscriptionReadOnlyError(result.error);
  }
}
