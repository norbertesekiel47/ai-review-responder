import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { SubscriptionTier } from '@/lib/accounts/tier-config';

const { mockTrialEnabled, mockAssertTierPurchasable } = vi.hoisted(() => ({
  mockTrialEnabled: vi.fn(),
  mockAssertTierPurchasable: vi.fn(),
}));

vi.mock('../flags', () => ({ trialEnabled: mockTrialEnabled }));
vi.mock('@/lib/payments/tier-purchasability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/tier-purchasability')>()),
  assertTierPurchasable: mockAssertTierPurchasable,
}));

import { applyTierSnapshot, resolveCheckoutContext } from '../plan-activation';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BUSINESS_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  mockTrialEnabled.mockReset();
  mockTrialEnabled.mockReturnValue(false);
  mockAssertTierPurchasable.mockReset();
});

function queueLocksAndRow(row: Record<string, unknown>): void {
  harness.sqlReturnQueue.push(mkTaggedResult([{}]));
  harness.sqlReturnQueue.push(mkTaggedResult([{}]));
  harness.sqlReturnQueue.push(mkTaggedResult([{}]));
  harness.sqlReturnQueue.push(mkTaggedResult([row]));
}

function queueBusinessMirrorSync(
  tier: string,
  status = 'pending_payment',
): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{ id: BUSINESS_ID }]),
    mkTaggedResult([{}]),
    mkTaggedResult([{ subscription_tier: tier, subscription_status: status }]),
    mkTaggedResult([{}]),
  );
}

describe('applyTierSnapshot', () => {
  it('writes the complete founding Autopilot pending snapshot with paid=0 in fixed lock order', async () => {
    queueLocksAndRow({
      subscription_status: 'pending_payment',
      price_variant: 'founding',
    });
    harness.sqlReturnQueue.push(mkTaggedResult([{ id: ACCOUNT_ID }]));
    harness.sqlReturnQueue.push(mkTaggedResult([{}]));
    queueBusinessMirrorSync(SubscriptionTier.AUTOPILOT);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
    });

    expect(result).toEqual({
      kind: 'ok',
      accountId: ACCOUNT_ID,
      variant: 'founding',
    });
    expect(mockAssertTierPurchasable).toHaveBeenCalledWith(
      SubscriptionTier.AUTOPILOT,
    );

    const lockValues = harness.sqlCalls.slice(0, 3).map((call) => call.values[0]);
    expect(lockValues).toEqual([
      `${ACCOUNT_ID}:tier_entitlement`,
      `${ACCOUNT_ID}:overage_sync`,
      `${BUSINESS_ID}:activation`,
    ]);
    expect(harness.sqlCalls[3]!.text).toContain('FOR UPDATE');

    const accountUpdate = harness.sqlCalls[4]!;
    expect(accountUpdate.text).toContain('UPDATE accounts');
    expect(accountUpdate.text).toContain('subscription_tier');
    expect(accountUpdate.text).toContain('base_price_cents');
    expect(accountUpdate.text).toContain('locations_overage_price_cents');
    expect(accountUpdate.text).toContain('locations_included');
    expect(accountUpdate.text).toContain('locations_paid');
    expect(accountUpdate.values).toEqual(
      expect.arrayContaining([
        SubscriptionTier.AUTOPILOT,
        4900,
        2000,
        1,
        0,
        ACCOUNT_ID,
      ]),
    );
    expect(harness.sqlCalls[6]!.text).toMatch(/FROM\s+businesses/);
    expect(harness.sqlCalls[6]!.text).toContain('FOR UPDATE');
    expect(harness.sqlCalls[7]!.values).toEqual([`${ACCOUNT_ID}:tier_entitlement`]);
    expect(harness.sqlCalls[8]!.text).toMatch(/FROM\s+accounts/);
    expect(harness.sqlCalls[9]!.text).toMatch(/UPDATE\s+businesses/);
    expect(harness.sqlReturnQueue).toHaveLength(0);
    expect(harness.sqlCalls).toHaveLength(10);
  });

  it('gate rejection performs no SQL and therefore no partial snapshot write', async () => {
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

    expect(harness.sqlCalls).toHaveLength(0);
    expect(harness.mockSql.begin).not.toHaveBeenCalled();
  });

  it('missing account returns not_found after exactly three locks and one row read', async () => {
    queueLocksAndRow({});
    // Replace the queued row with an empty result without draining it early.
    harness.sqlReturnQueue[3] = mkTaggedResult([]);

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.COPILOT,
    });

    expect(result).toEqual({ kind: 'not_found' });
    expect(harness.sqlCalls).toHaveLength(4);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('wrong status returns without any snapshot or audit write', async () => {
    queueLocksAndRow({ subscription_status: 'active', price_variant: 'list' });

    const result = await applyTierSnapshot(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.COPILOT,
    });

    expect(result).toEqual({ kind: 'wrong_status', status: 'active' });
    expect(harness.sqlCalls).toHaveLength(4);
    expect(harness.sqlReturnQueue).toHaveLength(0);
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
