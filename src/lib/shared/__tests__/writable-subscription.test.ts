import { describe, it, expect } from 'vitest';
import {
  assertWritableSubscriptionForAccount,
  assertWritableSubscriptionForBusiness,
  resolveWritableAccountForLocation,
} from '../writable-subscription';
import type { ActiveOffboardingProjection } from '@/lib/account-offboarding/gate';
import { SubscriptionStatus } from '../subscription-status';
import type { AccountFlagsInput } from '../past-due-recovery';

type AccountRow = ActiveOffboardingProjection & {
  id: string;
  subscription_status: string;
  past_due_at: Date | string | null;
  flags: AccountFlagsInput;
};

const DAY_MS = 86_400_000;

// postgres.js invokes `db` as a tagged template that resolves to the row set.
// The helper only awaits the first row, so a thunk returning the array is a
// faithful stand-in without booting a real connection.
function fakeDb(rows: AccountRow[]) {
  return fakeDbSequence(rows, []);
}

function fakeDbSequence(...rowSets: unknown[][]) {
  let callIndex = 0;
  const fn = () => Promise.resolve(rowSets[callIndex++] ?? []);
  return fn as unknown as Parameters<typeof resolveWritableAccountForLocation>[1];
}

function activeAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acc-1',
    subscription_status: SubscriptionStatus.ACTIVE,
    past_due_at: null,
    flags: null,
    ...overrides,
  };
}

function projectedOffboarding(overrides: Partial<ActiveOffboardingProjection> = {}): ActiveOffboardingProjection {
  return {
    offboarding_id: 'offboarding-1',
    offboarding_account_id: 'acc-1',
    offboarding_mode: 'delete_data',
    offboarding_status: 'pending',
    offboarding_failed_step: null,
    offboarding_access_ends_at: null,
    offboarding_teardown_started_at: null,
    offboarding_purge_after: null,
    offboarding_purge_started_at: null,
    offboarding_purge_cancelled_at: null,
    ...overrides,
  };
}

describe('assertWritableSubscriptionForAccount', () => {
  it('allows cancel-only scheduled offboarding for normal writable product routes', async () => {
    const result = await assertWritableSubscriptionForAccount(
      'acc-1',
      fakeDb([
        activeAccountRow(projectedOffboarding({
          offboarding_mode: 'cancel_only',
          offboarding_status: 'scheduled',
          offboarding_access_ends_at: new Date('2026-07-01T00:00:00.000Z'),
        })),
      ]),
    );

    expect(result).toEqual({ ok: true });
  });

  it('blocks active accounts in delete-data offboarding', async () => {
    const result = await assertWritableSubscriptionForAccount(
      'acc-1',
      fakeDb([activeAccountRow(projectedOffboarding())]),
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'account_offboarding_blocked',
    });
  });
});

describe('assertWritableSubscriptionForBusiness', () => {
  it('blocks when the joined account is in a full offboarding block', async () => {
    const result = await assertWritableSubscriptionForBusiness(
      'loc-1',
      fakeDb([
        activeAccountRow(projectedOffboarding({
          offboarding_mode: 'cancel_only',
          offboarding_status: 'tearing_down',
        })),
      ]),
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'account_offboarding_blocked',
    });
  });
});

describe('resolveWritableAccountForLocation', () => {
  it('returns no_account when the location has no joined account row', async () => {
    const result = await resolveWritableAccountForLocation('loc-1', fakeDb([]));
    expect(result).toEqual({ kind: 'no_account' });
  });

  it('returns ok with the account id for an active subscription', async () => {
    const result = await resolveWritableAccountForLocation(
      'loc-1',
      fakeDb([{ id: 'acc-1', subscription_status: SubscriptionStatus.ACTIVE, past_due_at: null, flags: null }]),
    );
    expect(result).toEqual({ kind: 'ok', accountId: 'acc-1' });
  });

  it('blocks a non-active, non-past-due subscription as subscription_not_active (403)', async () => {
    const result = await resolveWritableAccountForLocation(
      'loc-1',
      fakeDb([{ id: 'acc-1', subscription_status: SubscriptionStatus.CANCELLED, past_due_at: null, flags: null }]),
    );
    expect(result).toEqual({ kind: 'blocked', status: 403, error: 'subscription_not_active' });
  });

  it('blocks a past-due subscription beyond its grace window as past_due_read_only (402)', async () => {
    const longAgo = new Date(Date.now() - 30 * DAY_MS); // beyond the 7-day grace window
    const result = await resolveWritableAccountForLocation(
      'loc-1',
      fakeDb([{ id: 'acc-1', subscription_status: SubscriptionStatus.PAST_DUE, past_due_at: longAgo, flags: null }]),
    );
    expect(result).toEqual({ kind: 'blocked', status: 402, error: 'past_due_read_only' });
  });

  it('allows a past-due subscription still inside its grace window', async () => {
    const recent = new Date(Date.now() - 1 * DAY_MS); // within the 7-day grace window
    const result = await resolveWritableAccountForLocation(
      'loc-1',
      fakeDb([{ id: 'acc-1', subscription_status: SubscriptionStatus.PAST_DUE, past_due_at: recent, flags: null }]),
    );
    expect(result).toEqual({ kind: 'ok', accountId: 'acc-1' });
  });

  it('blocks active subscription routes when account offboarding is a full block', async () => {
    const result = await resolveWritableAccountForLocation(
      'loc-1',
      fakeDb([activeAccountRow(projectedOffboarding())]),
    );

    expect(result).toEqual({
      kind: 'blocked',
      status: 403,
      error: 'account_offboarding_blocked',
    });
  });

  it('still supports an explicit offboarding gate for callers that cache state separately', async () => {
    const offboardingGate = {
      getOffboardingState: async () => ({
        id: 'offboarding-1',
        accountId: 'acc-1',
        mode: 'delete_data' as const,
        status: 'pending' as const,
        failedStep: null,
        terminalAt: null,
        accessEndsAt: null,
        teardownStartedAt: null,
        purgeAfter: null,
        purgeStartedAt: null,
        purgeCancelledAt: null,
      }),
    };

    const result = await assertWritableSubscriptionForAccount(
      'acc-1',
      fakeDb([activeAccountRow()]),
      offboardingGate,
    );

    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'account_offboarding_blocked',
    });
  });
});
