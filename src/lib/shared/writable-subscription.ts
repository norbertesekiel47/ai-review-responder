import type postgres from 'postgres';
import { sql } from '@/lib/db/server';
import {
  computePastDueRecoveryState,
  type AccountFlagsInput,
  type PastDueRecoveryState,
} from './past-due-recovery';
import { SubscriptionStatus } from './subscription-status';

export type WritableSubscriptionResult =
  | { ok: true }
  | { ok: false; status: 402 | 403; error: string };

type SubscriptionSql = postgres.Sql | postgres.TransactionSql;

export class SubscriptionReadOnlyError extends Error {
  constructor(
    readonly error = 'past_due_read_only',
    readonly status: 402 | 403 = 402,
  ) {
    super(error);
    this.name = 'SubscriptionReadOnlyError';
  }
}

interface WritableSubscriptionStatusInput {
  subscriptionStatus: string;
  pastDueAt: Date | string | null | undefined;
  accountFlags?: AccountFlagsInput;
}

export function assertWritableSubscription(
  recovery: PastDueRecoveryState,
): WritableSubscriptionResult {
  if (recovery.isReadOnly) {
    return { ok: false, status: 402, error: 'past_due_read_only' };
  }
  return { ok: true };
}

export function assertWritableSubscriptionStatus(
  input: WritableSubscriptionStatusInput,
): WritableSubscriptionResult {
  if (input.subscriptionStatus === SubscriptionStatus.ACTIVE) {
    return { ok: true };
  }

  if (input.subscriptionStatus === SubscriptionStatus.PAST_DUE) {
    return assertWritableSubscription(computePastDueRecoveryState({
      subscriptionStatus: input.subscriptionStatus,
      pastDueAt: input.pastDueAt,
      accountFlags: input.accountFlags,
    }));
  }

  return { ok: false, status: 403, error: 'subscription_inactive' };
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
    return { ok: false, status: 403, error: 'no_business' };
  }

  return assertWritableSubscriptionStatus({
    subscriptionStatus: account.subscription_status,
    pastDueAt: account.past_due_at,
    accountFlags: account.flags,
  });
}

export async function assertWritableSubscriptionForBusiness(
  businessId: string,
  db: SubscriptionSql = sql,
): Promise<WritableSubscriptionResult> {
  const [account] = await db<{
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  }[]>`
    SELECT a.subscription_status, a.past_due_at, a.flags
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}::uuid
    LIMIT 1
  `;

  if (!account) {
    return { ok: false, status: 403, error: 'no_business' };
  }

  return assertWritableSubscriptionStatus({
    subscriptionStatus: account.subscription_status,
    pastDueAt: account.past_due_at,
    accountFlags: account.flags,
  });
}

export function throwIfReadOnly(result: WritableSubscriptionResult): void {
  if (!result.ok) {
    throw new SubscriptionReadOnlyError(result.error, result.status);
  }
}
