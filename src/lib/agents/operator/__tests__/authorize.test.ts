import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

const assertWritableSubscriptionForAccount = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/writable-subscription', () => ({ assertWritableSubscriptionForAccount }));

import { reauthorizeTurn } from '../authorize';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';

const input = { accountId: ACCOUNT, actorUserId: ACTOR, locationId: LOCATION };

describe('operator reauthorize', () => {
  beforeEach(() => {
    resetMockSql();
    vi.clearAllMocks();
  });

  it('reauthorizeTurn maps account_offboarding_blocked to account_offboarding', async () => {
    // The actor read succeeds, so the gate below is the only thing that can
    // decide the outcome.
    sqlReturnQueue.push([{ id: ACTOR }]);
    assertWritableSubscriptionForAccount.mockResolvedValue({
      ok: false, status: 403, error: 'account_offboarding_blocked',
    });

    const offboarding = await reauthorizeTurn(mockSql as unknown as postgres.Sql, input);

    expect(offboarding).toEqual({ ok: false, reason: 'account_offboarding' });
    expect(assertWritableSubscriptionForAccount).toHaveBeenCalledWith(ACCOUNT, mockSql);
    // It stopped AT the gate: no location read, no account read.
    expect(assertWritableSubscriptionForAccount).toHaveBeenCalledTimes(1);

    // The contrast is the point — the mapping is a named token, not a blanket
    // "gate said no". A past-due account is `unauthorized`, and collapsing the
    // two would tell an owner their account is closing when it is not.
    resetMockSql();
    vi.clearAllMocks();
    sqlReturnQueue.push([{ id: ACTOR }]);
    assertWritableSubscriptionForAccount.mockResolvedValue({
      ok: false, status: 402, error: 'past_due_read_only',
    });

    const pastDue = await reauthorizeTurn(mockSql as unknown as postgres.Sql, input);

    expect(pastDue).toEqual({ ok: false, reason: 'unauthorized' });
  });
});
