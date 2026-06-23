import type postgres from 'postgres';
import {
  activeOffboardingStateFromProjection,
  getOffboardingState,
  isProcessingBlocked,
  type ActiveOffboardingProjection,
  type OffboardingGate,
} from '@/lib/account-offboarding/gate';
import { sql } from '@/lib/db/server';
import {
  computePastDueRecoveryState,
  type AccountFlagsInput,
  type PastDueRecoveryState,
} from './past-due-recovery';
import {
  SubscriptionStatus,
  subscriptionGrantsFullAccess,
} from './subscription-status';

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
  if (subscriptionGrantsFullAccess(input.subscriptionStatus)) {
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
  const [account] = await db<Array<{
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  } & ActiveOffboardingProjection>>`
    SELECT
      a.subscription_status,
      a.past_due_at,
      a.flags,
      ao.id AS offboarding_id,
      ao.account_id AS offboarding_account_id,
      ao.mode AS offboarding_mode,
      ao.status AS offboarding_status,
      ao.failed_step AS offboarding_failed_step,
      ao.access_ends_at AS offboarding_access_ends_at,
      ao.teardown_started_at AS offboarding_teardown_started_at,
      ao.purge_after AS offboarding_purge_after,
      ao.purge_started_at AS offboarding_purge_started_at,
      ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM accounts a
    LEFT JOIN account_offboardings ao
      ON ao.account_id = a.id
     AND ao.terminal_at IS NULL
    WHERE a.id = ${accountId}::uuid
    ORDER BY ao.created_at DESC NULLS LAST
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

  if (offboardingGate) {
    return assertNoBlockingOffboardingForAccount(accountId, db, offboardingGate);
  }

  const offboardingState = activeOffboardingStateFromProjection(account);
  if (isProcessingBlocked(offboardingState)) {
    return { ok: false, status: 403, error: 'account_offboarding_blocked' };
  }
  return { ok: true };
}

export async function assertWritableSubscriptionForBusiness(
  businessId: string,
  db: SubscriptionSql = sql,
  offboardingGate?: Pick<OffboardingGate, 'getOffboardingState'>,
): Promise<WritableSubscriptionResult> {
  const [account] = await db<Array<{
    id: string;
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  } & ActiveOffboardingProjection>>`
    SELECT
      a.id,
      a.subscription_status,
      a.past_due_at,
      a.flags,
      ao.id AS offboarding_id,
      ao.account_id AS offboarding_account_id,
      ao.mode AS offboarding_mode,
      ao.status AS offboarding_status,
      ao.failed_step AS offboarding_failed_step,
      ao.access_ends_at AS offboarding_access_ends_at,
      ao.teardown_started_at AS offboarding_teardown_started_at,
      ao.purge_after AS offboarding_purge_after,
      ao.purge_started_at AS offboarding_purge_started_at,
      ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    LEFT JOIN account_offboardings ao
      ON ao.account_id = a.id
     AND ao.terminal_at IS NULL
    WHERE b.id = ${businessId}::uuid
    ORDER BY ao.created_at DESC NULLS LAST
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

  if (offboardingGate) {
    return assertNoBlockingOffboardingForAccount(account.id, db, offboardingGate);
  }

  const offboardingState = activeOffboardingStateFromProjection(account);
  if (isProcessingBlocked(offboardingState)) {
    return { ok: false, status: 403, error: 'account_offboarding_blocked' };
  }
  return { ok: true };
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
  const [accountRow] = await db<Array<{
    id: string;
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  } & ActiveOffboardingProjection>>`
    SELECT
      a.id,
      a.subscription_status,
      a.past_due_at,
      a.flags,
      ao.id AS offboarding_id,
      ao.account_id AS offboarding_account_id,
      ao.mode AS offboarding_mode,
      ao.status AS offboarding_status,
      ao.failed_step AS offboarding_failed_step,
      ao.access_ends_at AS offboarding_access_ends_at,
      ao.teardown_started_at AS offboarding_teardown_started_at,
      ao.purge_after AS offboarding_purge_after,
      ao.purge_started_at AS offboarding_purge_started_at,
      ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    LEFT JOIN account_offboardings ao
      ON ao.account_id = a.id
     AND ao.terminal_at IS NULL
    WHERE b.id = ${locationId}
    ORDER BY ao.created_at DESC NULLS LAST
    LIMIT 1
  `;
  if (!accountRow) return { kind: 'no_account' };

  if (accountRow.subscription_status === SubscriptionStatus.PAST_DUE) {
    const writable = assertWritableSubscription(computePastDueRecoveryState({
      subscriptionStatus: accountRow.subscription_status,
      pastDueAt: accountRow.past_due_at,
      accountFlags: accountRow.flags,
    }));
    if (!writable.ok) return { kind: 'blocked', status: writable.status, error: writable.error };
  } else if (!subscriptionGrantsFullAccess(accountRow.subscription_status)) {
    return { kind: 'blocked', status: 403, error: 'subscription_not_active' };
  }

  if (offboardingGate) {
    const offboarding = await assertNoBlockingOffboardingForAccount(accountRow.id, db, offboardingGate);
    if (!offboarding.ok) {
      return { kind: 'blocked', status: offboarding.status, error: offboarding.error };
    }
  } else {
    const offboardingState = activeOffboardingStateFromProjection(accountRow);
    if (isProcessingBlocked(offboardingState)) {
      return { kind: 'blocked', status: 403, error: 'account_offboarding_blocked' };
    }
  }

  return { kind: 'ok', accountId: accountRow.id };
}

export function throwIfReadOnly(result: WritableSubscriptionResult): void {
  if (!result.ok) {
    throw new SubscriptionReadOnlyError(result.error, result.status);
  }
}
