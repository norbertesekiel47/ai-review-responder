import { describe, it, expect } from 'vitest';
import { resolveWritableAccountForLocation } from '../writable-subscription';
import { SubscriptionStatus } from '../subscription-status';
import type { AccountFlagsInput } from '../past-due-recovery';

type AccountRow = {
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
  const fn = () => Promise.resolve(rows);
  return fn as unknown as Parameters<typeof resolveWritableAccountForLocation>[1];
}

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
});
