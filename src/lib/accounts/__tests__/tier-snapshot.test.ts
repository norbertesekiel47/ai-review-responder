import { beforeEach, describe, expect, it } from 'vitest';
import type { TransactionSql } from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import { SubscriptionTier } from '../tier-config';
import {
  writeResolvedTierSnapshot,
  writeTierSnapshot,
} from '../tier-snapshot';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let harness: MockSqlHarness;
let tx: TransactionSql;

beforeEach(() => {
  harness = createMockSql();
  tx = harness.mockSql as unknown as TransactionSql;
});

describe('writeTierSnapshot', () => {
  it('writes all five Autopilot/founding fields, mirror, and change-only audit', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: ACCOUNT_ID }]),
      mkTaggedResult([{}]),
      mkTaggedResult([{}]),
    );

    const result = await writeTierSnapshot(tx, {
      accountId: ACCOUNT_ID,
      tier: SubscriptionTier.AUTOPILOT,
      variant: 'founding',
      locationsPaid: 3,
      audit: { eventType: 'subscription_updated', payload: { source: 'test' } },
    });

    expect(result).toEqual({
      changed: true,
      snapshot: {
        tier: SubscriptionTier.AUTOPILOT,
        variant: 'founding',
        baseCents: 4900,
        overageCents: 2000,
        included: 1,
      },
    });
    const update = harness.sqlCalls[0]!;
    expect(update.text).toMatch(/UPDATE\s+accounts/);
    for (const column of [
      'subscription_tier',
      'base_price_cents',
      'locations_overage_price_cents',
      'locations_included',
      'locations_paid',
    ]) {
      expect(update.text).toContain(column);
    }
    expect(update.values).toEqual(
      expect.arrayContaining(['autopilot', 4900, 2000, 1, 3, ACCOUNT_ID]),
    );
    expect(harness.sqlCalls[1]!.text).toMatch(/UPDATE\s+businesses/);
    expect(harness.sqlCalls[2]!.text).toMatch(/INSERT\s+INTO\s+account_audit_log/);
    expect(harness.sqlCalls).toHaveLength(3);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('replay with an identical snapshot writes no audit', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([]), mkTaggedResult([]));
    const result = await writeTierSnapshot(tx, {
      accountId: ACCOUNT_ID,
      tier: SubscriptionTier.COPILOT,
      variant: 'list',
      locationsPaid: 0,
      audit: { eventType: 'subscription_updated' },
    });
    expect(result.changed).toBe(false);
    expect(harness.sqlCalls).toHaveLength(2);
    expect(harness.sqlCalls.some((call) => /account_audit_log/.test(call.text))).toBe(false);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('writes an existing stored snapshot without consulting live tier pricing', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: ACCOUNT_ID }]),
      mkTaggedResult([]),
    );
    const result = await writeResolvedTierSnapshot(tx, {
      accountId: ACCOUNT_ID,
      snapshot: {
        tier: SubscriptionTier.COPILOT,
        variant: 'founding',
        baseCents: 2345,
        overageCents: 1678,
        included: 4,
      },
      locationsPaid: 2,
    });

    expect(result.snapshot).toEqual({
      tier: SubscriptionTier.COPILOT,
      variant: 'founding',
      baseCents: 2345,
      overageCents: 1678,
      included: 4,
    });
    expect(harness.sqlCalls[0]!.values).toEqual(
      expect.arrayContaining(['copilot', 2345, 1678, 4, 2, ACCOUNT_ID]),
    );
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('rejects untrusted negative or fractional quantities before SQL', async () => {
    await expect(
      writeTierSnapshot(tx, {
        accountId: ACCOUNT_ID,
        tier: SubscriptionTier.COPILOT,
        variant: 'list',
        locationsPaid: -1,
      }),
    ).rejects.toThrow('locationsPaid');
    await expect(
      writeTierSnapshot(tx, {
        accountId: ACCOUNT_ID,
        tier: SubscriptionTier.COPILOT,
        variant: 'list',
        locationsPaid: 1.5,
      }),
    ).rejects.toThrow('locationsPaid');
    expect(harness.sqlCalls).toHaveLength(0);
  });
});
