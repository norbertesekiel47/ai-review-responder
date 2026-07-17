import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { SubscriptionTier } from '@/lib/accounts/tier-config';

const {
  mockTrialEnabled,
  mockStripeTaxEnabled,
  mockAssertTierPurchasable,
  retrieveSessionMock,
  expireSessionMock,
} = vi.hoisted(() => ({
  mockTrialEnabled: vi.fn(),
  mockStripeTaxEnabled: vi.fn(),
  mockAssertTierPurchasable: vi.fn(),
  retrieveSessionMock: vi.fn(),
  expireSessionMock: vi.fn(),
}));

vi.mock('../flags', () => ({
  trialEnabled: mockTrialEnabled,
  stripeTaxEnabled: mockStripeTaxEnabled,
}));
vi.mock('@/lib/payments/tier-purchasability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/tier-purchasability')>()),
  assertTierPurchasable: mockAssertTierPurchasable,
}));
vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        retrieve: retrieveSessionMock,
        expire: expireSessionMock,
      },
    },
  }),
}));

import {
  applyTierSnapshot as applyTierSnapshotImpl,
  CheckoutAttemptConflictError,
  resolveCheckoutContext,
  type ApplyTierSnapshotParams,
} from '../plan-activation';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BUSINESS_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'cs_prior';

let harness: MockSqlHarness;
let mockSql: Sql;

function applyTierSnapshot(
  sql: Sql,
  params: Omit<ApplyTierSnapshotParams, 'ownerEmail' | 'trial'> &
    Partial<Pick<ApplyTierSnapshotParams, 'ownerEmail' | 'trial'>>,
) {
  return applyTierSnapshotImpl(sql, {
    ownerEmail: 'owner@example.com',
    trial: false,
    ...params,
  });
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    subscription_status: 'pending_payment',
    price_variant: 'list',
    active_locations: 3,
    checkout_attempt_id: null,
    checkout_session_id: null,
    checkout_attempt_state: null,
    checkout_attempt_tier: null,
    checkout_attempt_price_variant: null,
    checkout_attempt_base_price_id: null,
    checkout_attempt_overage_price_id: null,
    checkout_attempt_base_price_cents: null,
    checkout_attempt_overage_price_cents: null,
    checkout_attempt_locations_included: null,
    checkout_attempt_locations_paid: null,
    checkout_attempt_overage_quantity: null,
    ...overrides,
  };
}

function copilotAttempt(overrides: Record<string, unknown> = {}) {
  return accountRow({
    checkout_attempt_id: ATTEMPT_ID,
    checkout_session_id: SESSION_ID,
    checkout_attempt_state: 'open',
    checkout_attempt_tier: 'copilot',
    checkout_attempt_price_variant: 'list',
    checkout_attempt_base_price_id: 'price_copilot_list',
    checkout_attempt_overage_price_id: 'price_copilot_overage',
    checkout_attempt_base_price_cents: 2900,
    checkout_attempt_overage_price_cents: 1500,
    checkout_attempt_locations_included: 1,
    checkout_attempt_locations_paid: 0,
    checkout_attempt_overage_quantity: 2,
    ...overrides,
  });
}

function queueLocksAndRow(row: Record<string, unknown> | null): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult(row ? [{ id: ACCOUNT_ID }] : []),
  );
  if (row) harness.sqlReturnQueue.push(mkTaggedResult([row]));
}

function queueBusinessMirrorSync(tier: string): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{ id: BUSINESS_ID }]),
    mkTaggedResult([{}]),
    mkTaggedResult([{ subscription_tier: tier }]),
    mkTaggedResult([{}]),
  );
}

function queueNewSelection(row = accountRow()): void {
  queueLocksAndRow(row);
  harness.sqlReturnQueue.push(
    mkTaggedResult([
      {
        subscription_status: 'pending_payment',
        price_variant: row.price_variant,
      },
    ]),
    mkTaggedResult([{ id: ACCOUNT_ID }]),
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
  );
}

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  mockTrialEnabled.mockReset();
  mockTrialEnabled.mockReturnValue(false);
  mockStripeTaxEnabled.mockReset();
  mockStripeTaxEnabled.mockReturnValue(false);
  mockAssertTierPurchasable.mockReset();
  retrieveSessionMock.mockReset();
  retrieveSessionMock.mockResolvedValue({ id: SESSION_ID, status: 'open' });
  expireSessionMock.mockReset();
  expireSessionMock.mockResolvedValue({ id: SESSION_ID, status: 'expired' });
  vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', 'price_copilot_list');
  vi.stubEnv('STRIPE_PRICE_COPILOT_FOUNDING', 'price_copilot_founding');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_LIST', 'price_autopilot_list');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_FOUNDING', 'price_autopilot_founding');
  vi.stubEnv('STRIPE_PRICE_COPILOT_OVERAGE', 'price_copilot_overage');
  vi.stubEnv('STRIPE_PRICE_AUTOPILOT_OVERAGE', 'price_autopilot_overage');
});

describe('applyTierSnapshot authoritative Checkout attempt', () => {
  it('writes the full founding Autopilot lease and pending billing snapshot in fixed lock order', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://frozen.example.com');
    mockStripeTaxEnabled.mockReturnValue(true);
    queueNewSelection(accountRow({ price_variant: 'founding' }));
    queueBusinessMirrorSync(SubscriptionTier.AUTOPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
      ownerEmail: '  founder@example.com  ',
      trial: true,
    });

    expect(result).toMatchObject({
      kind: 'ok',
      accountId: ACCOUNT_ID,
      variant: 'founding',
      attemptId: expect.any(String),
    });
    const calls = harness.sqlCalls;
    expect(calls.slice(0, 3).map((call) => call.values[0])).toEqual([
      `${ACCOUNT_ID}:tier_entitlement`,
      `${ACCOUNT_ID}:overage_sync`,
      `${BUSINESS_ID}:activation`,
    ]);
    expect(calls[3]!.text).toContain('FOR UPDATE');
    expect(calls[4]!.text).not.toContain('FOR UPDATE');
    const snapshotWrite = calls[6]!;
    expect(snapshotWrite.values).toEqual(
      expect.arrayContaining(['autopilot', 4900, 2000, 1, 0, ACCOUNT_ID]),
    );
    const leaseWrite = calls[8]!;
    expect(leaseWrite.text).toMatch(/checkout_attempt_state\s*=\s*'creating'/);
    expect(leaseWrite.values).toEqual(
      expect.arrayContaining([
        'autopilot',
        'founding',
        'price_autopilot_founding',
        'price_autopilot_overage',
        4900,
        2000,
        1,
        2,
        30,
        true,
        'founder@example.com',
        'https://frozen.example.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}',
        'https://frozen.example.com/onboarding/pay?cancelled=true',
        ACCOUNT_ID,
      ]),
    );
    expect(harness.sqlReturnQueue).toHaveLength(0);
    expect(calls).toHaveLength(13);
  });

  it('reuses the stable identity for the same creating attempt', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', '');
    queueLocksAndRow(
      copilotAttempt({
        checkout_session_id: null,
        checkout_attempt_state: 'creating',
      }),
    );
    queueBusinessMirrorSync(SubscriptionTier.COPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.COPILOT,
      ownerEmail: '   ',
      trial: true,
    });

    expect(result).toEqual({
      kind: 'ok',
      accountId: ACCOUNT_ID,
      variant: 'list',
      attemptId: ATTEMPT_ID,
    });
    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(9);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('same-selection replay reuses the provider-open Session', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', 'price_deploy_drift');
    queueLocksAndRow(copilotAttempt());
    queueBusinessMirrorSync(SubscriptionTier.COPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.COPILOT,
      ownerEmail: '   ',
      trial: true,
    });

    expect(result).toMatchObject({ attemptId: ATTEMPT_ID });
    expect(retrieveSessionMock).toHaveBeenCalledWith(SESSION_ID);
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(9);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('gate closure still permits exact reuse of an authoritative open Session', async () => {
    queueLocksAndRow(copilotAttempt({
      subscription_tier: 'autopilot',
      checkout_attempt_tier: 'autopilot',
      checkout_attempt_base_price_id: 'price_autopilot_list',
      checkout_attempt_overage_price_id: 'price_autopilot_overage',
      checkout_attempt_base_price_cents: 6900,
      checkout_attempt_overage_price_cents: 2000,
    }));
    queueBusinessMirrorSync(SubscriptionTier.AUTOPILOT);
    mockAssertTierPurchasable.mockImplementation(() => {
      throw new Error('gate closed');
    });

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
    });

    expect(result).toMatchObject({ kind: 'ok', attemptId: ATTEMPT_ID });
    expect(retrieveSessionMock).toHaveBeenCalledWith(SESSION_ID);
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(mockAssertTierPurchasable).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(9);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('gate-closed different-tier selection does not expire the existing open Session', async () => {
    queueLocksAndRow(copilotAttempt());
    mockAssertTierPurchasable.mockImplementationOnce(() => {
      throw new Error('Autopilot unavailable');
    });

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toThrow('Autopilot unavailable');

    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(
      false,
    );
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('expires the previous open Session before persisting a replacement selection', async () => {
    queueNewSelection(copilotAttempt());
    queueBusinessMirrorSync(SubscriptionTier.AUTOPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
    });

    expect(result).toMatchObject({ kind: 'ok', variant: 'list' });
    expect(result.kind === 'ok' && result.attemptId).not.toBe(ATTEMPT_ID);
    expect(expireSessionMock).toHaveBeenCalledWith(
      SESSION_ID,
      {},
      { idempotencyKey: `checkout-attempt-expire:v1:${SESSION_ID}` },
    );
    expect(harness.sqlCalls).toHaveLength(13);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('blocks replacement when the prior Session is already complete', async () => {
    queueLocksAndRow(copilotAttempt());
    retrieveSessionMock.mockResolvedValueOnce({
      id: SESSION_ID,
      status: 'complete',
    });

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('failed expiry leaves the old lease intact and creates no replacement', async () => {
    queueLocksAndRow(copilotAttempt());
    expireSessionMock.mockRejectedValueOnce(new Error('provider expiry failed'));
    retrieveSessionMock
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'open' })
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'open' });

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toThrow('provider expiry failed');
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(
      false,
    );
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('expire-versus-complete race converges by blocking the replacement', async () => {
    queueLocksAndRow(copilotAttempt());
    expireSessionMock.mockRejectedValueOnce(new Error('session no longer open'));
    retrieveSessionMock
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'open' })
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'complete' });

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(
      false,
    );
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('a different selection cannot supersede a provider-ambiguous creating attempt', async () => {
    queueLocksAndRow(
      copilotAttempt({
        checkout_session_id: null,
        checkout_attempt_state: 'creating',
      }),
    );

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);
    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('gate rejection performs no mutation or provider call', async () => {
    queueLocksAndRow(accountRow());
    mockAssertTierPurchasable.mockImplementationOnce(() => {
      throw new Error('Autopilot unavailable');
    });
    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.AUTOPILOT,
      }),
    ).rejects.toThrow('Autopilot unavailable');
    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(
      false,
    );
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('blocks a pending account with active delete-data offboarding before provider or snapshot work', async () => {
    queueLocksAndRow(accountRow({
      offboarding_id: '22222222-3333-4444-8555-666666666666',
      offboarding_account_id: ACCOUNT_ID,
      offboarding_mode: 'delete_data',
      offboarding_status: 'pending',
      offboarding_failed_step: null,
      offboarding_access_ends_at: null,
      offboarding_teardown_started_at: null,
      offboarding_purge_after: null,
      offboarding_purge_started_at: null,
      offboarding_purge_cancelled_at: null,
    }));

    await expect(
      applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.COPILOT,
      }),
    ).resolves.toEqual({ kind: 'offboarding_blocked' });

    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(
      harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text)),
    ).toBe(false);
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('missing and non-pending accounts perform no provider or snapshot writes', async () => {
    queueLocksAndRow(null);
    expect(
      await applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.COPILOT,
      }),
    ).toEqual({ kind: 'not_found' });
    expect(harness.sqlCalls).toHaveLength(4);
    expect(harness.sqlReturnQueue).toHaveLength(0);

    harness.resetMockSql();
    queueLocksAndRow(accountRow({ subscription_status: 'active' }));
    expect(
      await applyTierSnapshot(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier: SubscriptionTier.COPILOT,
      }),
    ).toEqual({ kind: 'wrong_status', status: 'active' });
    expect(harness.sqlCalls).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
    expect(retrieveSessionMock).not.toHaveBeenCalled();
  });
});

describe('resolveCheckoutContext', () => {
  it('returns null when the business row is missing', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    expect(await resolveCheckoutContext(mockSql, BUSINESS_ID)).toBeNull();
    expect(harness.sqlCalls).toHaveLength(1);
  });

  it('allows a configured trial only for a self-serve business', async () => {
    mockTrialEnabled.mockReturnValue(true);
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ account_id: ACCOUNT_ID, onboarded_by: null }]),
    );
    expect(await resolveCheckoutContext(mockSql, BUSINESS_ID)).toEqual({
      accountId: ACCOUNT_ID,
      trialEligible: true,
    });
  });

  it('denies a trial to admin-provisioned businesses', async () => {
    mockTrialEnabled.mockReturnValue(true);
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ account_id: ACCOUNT_ID, onboarded_by: 'admin-1' }]),
    );
    expect(await resolveCheckoutContext(mockSql, BUSINESS_ID)).toEqual({
      accountId: ACCOUNT_ID,
      trialEligible: false,
    });
  });
});
