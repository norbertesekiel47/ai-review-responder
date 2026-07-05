// src/lib/accounts/__tests__/tier-change.test.ts
//
// TDD assertions for tier change validation and downgrade billing preview.
// Validation contract: VAL-BILLING-045, VAL-BILLING-046, VAL-BILLING-047.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

// tier-change.ts is born-injected (sql is a parameter, A+ campaign PR 2b), so
// @/lib/db/server no longer needs mocking here — the fragment-aware
// createMockSql harness stands in for `sql` directly. validateTierChange
// doesn't touch jsonb (only applyTierChange/persistTierChangeTx do, covered
// by src/app/api/billing/tier-change/__tests__/route.test.ts), so no `.json`
// setup is needed for this suite.

import { validateTierChange } from '../tier-change';

// ── Helpers ──────────────────────────────────────────────────────────────

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

function mockAccountRow(tier: string, status: string) {
  return {
    subscription_tier: tier,
    subscription_status: status,
  };
}

function mockLocationCount(count: number) {
  return [{ count }];
}

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── validateTierChange ────────────────────────────────────────────────────

describe('validateTierChange', () => {
  // VAL-BILLING-045: Tier downgrade with excess locations is allowed
  it('allows premium→standard downgrade with 6 locations (5 overage)', async () => {
    harness.sqlReturnQueue.push([mockAccountRow('premium', 'active')]); // account lookup
    harness.sqlReturnQueue.push(mockLocationCount(6)); // location count

    const result = await validateTierChange(mockSql, ACCOUNT_ID, 'standard');

    expect(result.allowed).toBe(true);
    expect(result.newBillingPreview).toBeDefined();
    expect(result.newBillingPreview!.basePriceCents).toBe(7900); // $79 standard base
    expect(result.newBillingPreview!.overagePriceCents).toBe(2500); // $25 standard overage
    expect(result.newBillingPreview!.overageUnits).toBe(5); // 6 - 1 = 5
    expect(result.newBillingPreview!.totalCents).toBe(7900 + 5 * 2500); // $204
  });

  // VAL-BILLING-046: Downgrade modal calculates overage correctly for each tier transition
  describe('downgrade scenarios', () => {
    it('premium→standard: 6 locations, 5 overage at $25', async () => {
      harness.sqlReturnQueue.push([mockAccountRow('premium', 'active')]);
      harness.sqlReturnQueue.push(mockLocationCount(6));

      const result = await validateTierChange(mockSql, ACCOUNT_ID, 'standard');
      expect(result.allowed).toBe(true);
      expect(result.newBillingPreview!.overageUnits).toBe(5);
      expect(result.newBillingPreview!.totalCents).toBe(7900 + 5 * 2500);
    });

    it('premium→founders: 6 locations, 5 overage at $25', async () => {
      harness.sqlReturnQueue.push([mockAccountRow('premium', 'active')]);
      harness.sqlReturnQueue.push(mockLocationCount(6));

      const result = await validateTierChange(mockSql, ACCOUNT_ID, 'founders');
      expect(result.allowed).toBe(true);
      expect(result.newBillingPreview!.overageUnits).toBe(5);
      expect(result.newBillingPreview!.totalCents).toBe(1900 + 5 * 2500);
    });

    it('standard→founders: 2 locations, 1 overage at $25', async () => {
      harness.sqlReturnQueue.push([mockAccountRow('standard', 'active')]);
      harness.sqlReturnQueue.push(mockLocationCount(2));

      const result = await validateTierChange(mockSql, ACCOUNT_ID, 'founders');
      expect(result.allowed).toBe(true);
      expect(result.newBillingPreview!.overageUnits).toBe(1);
      expect(result.newBillingPreview!.totalCents).toBe(1900 + 1 * 2500);
    });
  });

  // VAL-BILLING-047: Tier downgrade to basic with >1 active locations is blocked
  it('blocks downgrade to basic with >1 active locations', async () => {
    harness.sqlReturnQueue.push([mockAccountRow('standard', 'active')]);
    harness.sqlReturnQueue.push(mockLocationCount(3));

    const result = await validateTierChange(mockSql, ACCOUNT_ID, 'basic');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('basic_requires_single_location');
  });

  it('allows downgrade to basic with exactly 1 active location', async () => {
    harness.sqlReturnQueue.push([mockAccountRow('standard', 'active')]);
    harness.sqlReturnQueue.push(mockLocationCount(1));

    const result = await validateTierChange(mockSql, ACCOUNT_ID, 'basic');

    expect(result.allowed).toBe(true);
    expect(result.newBillingPreview!.basePriceCents).toBe(2900);
    expect(result.newBillingPreview!.overageUnits).toBe(0);
  });

  it('rejects unknown tier', async () => {
    const result = await validateTierChange(mockSql, ACCOUNT_ID, 'enterprise');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unknown_tier');
  });

  it('rejects same tier change', async () => {
    harness.sqlReturnQueue.push([mockAccountRow('standard', 'active')]);

    const result = await validateTierChange(mockSql, ACCOUNT_ID, 'standard');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('same_tier');
  });

  it('rejects tier change for inactive subscription', async () => {
    harness.sqlReturnQueue.push([mockAccountRow('standard', 'pending_payment')]);

    const result = await validateTierChange(mockSql, ACCOUNT_ID, 'premium');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('subscription_inactive');
  });

  it('rejects tier change for cancelled subscription', async () => {
    harness.sqlReturnQueue.push([mockAccountRow('standard', 'cancelled')]);

    const result = await validateTierChange(mockSql, ACCOUNT_ID, 'premium');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('subscription_inactive');
  });

  // Upgrade is always allowed
  it('allows upgrade standard→premium with no overage preview', async () => {
    harness.sqlReturnQueue.push([mockAccountRow('standard', 'active')]);
    harness.sqlReturnQueue.push(mockLocationCount(3));

    const result = await validateTierChange(mockSql, ACCOUNT_ID, 'premium');

    expect(result.allowed).toBe(true);
    expect(result.newBillingPreview!.basePriceCents).toBe(19900);
    expect(result.newBillingPreview!.overageUnits).toBe(0); // 3 ≤ 5 included
    expect(result.newBillingPreview!.totalCents).toBe(19900);
  });
});
