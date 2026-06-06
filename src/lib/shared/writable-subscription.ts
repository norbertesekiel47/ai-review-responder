import type postgres from 'postgres';
import {
  getOffboardingState,
  isProcessingBlocked,
  type OffboardingGate,
} from '@/lib/account-offboarding/gate';
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

async function assertNoBlockingOffboardingForAccount(
  accountId: string,
  db: SubscriptionSql,
  offboardingGate?: Pick<OffboardingGate, 'getOffboardingState'>,
): Promise<WritableSubscriptionResult> {
  const state = offboardingGate
    ? await offboardingGate.getOffboardingState(accountId)
    : await getOffboardingState(accountId, db);
  if (isProcessingBlocked(state)) {
    return { ok: false, status: 403, error: 'account_offboarding_blocked' };
  }
  return { ok: true };
}

export async function assertWritableSubscriptionForAccount(
  accountId: string,
  db: SubscriptionSql = sql,
  offboardingGate?: Pick<OffboardingGate, 'getOffboardingState'>,
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

  const subscription = assertWritableSubscriptionStatus({
    subscriptionStatus: account.subscription_status,
    pastDueAt: account.past_due_at,
    accountFlags: account.flags,
  });

  if (!subscription.ok) return subscription;

  return assertNoBlockingOffboardingForAccount(accountId, db, offboardingGate);
}

export async function assertWritableSubscriptionForBusiness(
  businessId: string,
  db: SubscriptionSql = sql,
  offboardingGate?: Pick<OffboardingGate, 'getOffboardingState'>,
): Promise<WritableSubscriptionResult> {
  const [account] = await db<{
    id: string;
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  }[]>`
    SELECT a.id, a.subscription_status, a.past_due_at, a.flags
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}::uuid
    LIMIT 1
  `;

  if (!account) {
    return { ok: false, status: 403, error: 'no_business' };
  }

  const subscription = assertWritableSubscriptionStatus({
    subscriptionStatus: account.subscription_status,
    pastDueAt: account.past_due_at,
    accountFlags: account.flags,
  });

  if (!subscription.ok) return subscription;

  return assertNoBlockingOffboardingForAccount(account.id, db, offboardingGate);
}

export type WritableAccountForLocation =
  | { kind: 'ok'; accountId: string }
  | { kind: 'no_account' }
  | { kind: 'blocked'; status: 402 | 403; error: string };

/**
 * Loads the billing account for a location (business) and applies the
 * owner-facing writable-subscription gate, returning the account id on success.
 *
 * This is the shared form of the gate the owner-scoped dashboard channel
 * routes (telegram/whatsapp start/cancel/disable) ran inline. Callers map the
 * `no_account` outcome to their own status — enrollment `start` returns 404
 * `not_found`, while `cancel`/`disable` return 403 `subscription_not_active` —
 * and surface `blocked` (402 `past_due_read_only` / 403 subscription or
 * offboarding blocks) verbatim. After migration 034 subscription_status lives
 * on accounts, so this joins businesses → accounts and hands back the account
 * id the routes need for the advisory lock and channel-cache invalidation.
 */
export async function resolveWritableAccountForLocation(
  locationId: string,
  db: SubscriptionSql = sql,
  offboardingGate?: Pick<OffboardingGate, 'getOffboardingState'>,
): Promise<WritableAccountForLocation> {
  const [accountRow] = await db<{
    id: string;
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  }[]>`
    SELECT a.id, a.subscription_status, a.past_due_at, a.flags
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${locationId}
  `;
  if (!accountRow) return { kind: 'no_account' };

  if (accountRow.subscription_status === SubscriptionStatus.PAST_DUE) {
    const writable = assertWritableSubscription(computePastDueRecoveryState({
      subscriptionStatus: accountRow.subscription_status,
      pastDueAt: accountRow.past_due_at,
      accountFlags: accountRow.flags,
    }));
    if (!writable.ok) return { kind: 'blocked', status: writable.status, error: writable.error };
  } else if (accountRow.subscription_status !== SubscriptionStatus.ACTIVE) {
    return { kind: 'blocked', status: 403, error: 'subscription_not_active' };
  }

  const offboarding = await assertNoBlockingOffboardingForAccount(accountRow.id, db, offboardingGate);
  if (!offboarding.ok) {
    return { kind: 'blocked', status: offboarding.status, error: offboarding.error };
  }

  return { kind: 'ok', accountId: accountRow.id };
}

export function throwIfReadOnly(result: WritableSubscriptionResult): void {
  if (!result.ok) {
    throw new SubscriptionReadOnlyError(result.error, result.status);
  }
}
