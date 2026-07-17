// src/lib/accounts/__tests__/quota.test.ts
//
// TDD assertions for computeOverageQuantity, currentBillingSnapshot,
// and assertCanAddLocation.
// Validation contract: VAL-BILLING-017 through VAL-BILLING-027,
// VAL-LOC-001 through VAL-LOC-006.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
import type { SubscriptionTierValue } from '../tier-config';

// quota.ts is born-injected (sql is a parameter, A+ campaign PR 2b), so
// @/lib/db/server no longer needs mocking here — the fragment-aware
// createMockSql harness stands in for `sql` directly.

import {
  computeOverageQuantity,
  currentBillingSnapshot,
  assertCanAddLocation,
} from '../quota';

// ── computeOverageQuantity ────────────────────────────────────────────────

describe('computeOverageQuantity', () => {
  // VAL-BILLING-017
  it('returns 0 when locationsCount=0, included=1', () => {
    expect(computeOverageQuantity(0, 1)).toBe(0);
  });

  // VAL-BILLING-018
  it('returns 0 when locationsCount=1, included=1 (at quota)', () => {
    expect(computeOverageQuantity(1, 1)).toBe(0);
  });

  // VAL-BILLING-019
  it('returns 1 when locationsCount=2, included=1 (one over)', () => {
    expect(computeOverageQuantity(2, 1)).toBe(1);
  });

  // VAL-BILLING-020
  it('returns 0 when locationsCount=5, included=5 (at quota)', () => {
    expect(computeOverageQuantity(5, 5)).toBe(0);
  });

  // VAL-BILLING-021
  it('returns 1 when locationsCount=6, included=5', () => {
    expect(computeOverageQuantity(6, 5)).toBe(1);
  });

  // VAL-BILLING-022
  it('returns 9 when locationsCount=10, included=1 (deep overage)', () => {
    expect(computeOverageQuantity(10, 1)).toBe(9);
  });

  // VAL-BILLING-023 — never negative
  describe('never returns negative', () => {
    it('returns 0 when locationsCount=0, included=5', () => {
      expect(computeOverageQuantity(0, 5)).toBe(0);
    });

    it('returns 0 when locationsCount=1, included=5', () => {
      expect(computeOverageQuantity(1, 5)).toBe(0);
    });

    it('returns 0 when locationsCount=4, included=5', () => {
      expect(computeOverageQuantity(4, 5)).toBe(0);
    });
  });

  // Additional edge cases
  it('returns 0 when included=0 (no quota)', () => {
    expect(computeOverageQuantity(0, 0)).toBe(0);
  });

  it('returns correct overage when included=0 and locations>0', () => {
    expect(computeOverageQuantity(3, 0)).toBe(3);
  });
});

// ── Shared sql harness ────────────────────────────────────────────────────

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

// ── currentBillingSnapshot ─────────────────────────────────────────────────

// Helper to build the account row that currentBillingSnapshot expects
function mockAccountRow(
  tier: SubscriptionTierValue,
  locationsIncluded: number,
  locationsPaid: number,
  locationsOveragePriceCents: number = tier === 'autopilot' ? 2000 : 1500,
  basePriceCents: number = tier === 'autopilot' ? 6900 : 2900,
) {
  return {
    subscription_tier: tier,
    locations_included: locationsIncluded,
    locations_paid: locationsPaid,
    locations_overage_price_cents: locationsOveragePriceCents,
    base_price_cents: basePriceCents,
  };
}

// Helper to mock the active location count query
function mockLocationCount(count: number) {
  return [{ count }];
}

describe('currentBillingSnapshot', () => {
  // VAL-BILLING-024 — Copilot
  it('returns the stored Copilot snapshot with overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // First query returns account row
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 1, 3),
    ]);
    // Second query returns active location count
    harness.sqlReturnQueue.push(mockLocationCount(4));

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(2900);
    expect(snapshot.includedLocations).toBe(1);
    expect(snapshot.overagePriceCents).toBe(1500);
    expect(snapshot.overageUnits).toBe(3); // 4 - 1 = 3
    expect(snapshot.totalCents).toBe(2900 + 3 * 1500);
  });

  it('uses a stored Copilot included quota below a custom quota', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 3, 0),
    ]);
    harness.sqlReturnQueue.push(mockLocationCount(2));

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(2900);
    expect(snapshot.includedLocations).toBe(3);
    expect(snapshot.overagePriceCents).toBe(1500);
    expect(snapshot.overageUnits).toBe(0);
    expect(snapshot.totalCents).toBe(2900);
  });

  it('uses a stored Copilot included quota above a custom quota', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 3, 0),
    ]);
    harness.sqlReturnQueue.push(mockLocationCount(5));

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(2900);
    expect(snapshot.includedLocations).toBe(3);
    expect(snapshot.overagePriceCents).toBe(1500);
    expect(snapshot.overageUnits).toBe(2);
    expect(snapshot.totalCents).toBe(2900 + 2 * 1500);
  });

  it('uses a stored Copilot overage price for snapshot totals', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 1, 0, 3000),
    ]);
    harness.sqlReturnQueue.push(mockLocationCount(3));

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(2900);
    expect(snapshot.includedLocations).toBe(1);
    expect(snapshot.overagePriceCents).toBe(3000);
    expect(snapshot.overageUnits).toBe(2);
    expect(snapshot.totalCents).toBe(2900 + 2 * 3000);
  });

  // A stored zero-overage snapshot remains authoritative.
  it('returns no overage when the stored Copilot snapshot has zero overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 1, 0, 0),
    ]);

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(2900);
    expect(snapshot.includedLocations).toBe(1);
    expect(snapshot.overagePriceCents).toBe(0);
    expect(snapshot.overageUnits).toBe(0);
    expect(snapshot.totalCents).toBe(2900);
    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  // VAL-BILLING-026 — Autopilot
  it('returns the stored Autopilot snapshot with overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([
      mockAccountRow('autopilot', 1, 0),
    ]);
    harness.sqlReturnQueue.push(mockLocationCount(3));

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(6900);
    expect(snapshot.includedLocations).toBe(1);
    expect(snapshot.overagePriceCents).toBe(2000);
    expect(snapshot.overageUnits).toBe(2);
    expect(snapshot.totalCents).toBe(6900 + 2 * 2000);
  });

  // VAL-BILLING-027 — immutable founding Copilot snapshot
  it('returns a stored founding Copilot snapshot', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 1, 0, 1500, 1900),
    ]);
    harness.sqlReturnQueue.push(mockLocationCount(3));

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(1900);
    expect(snapshot.includedLocations).toBe(1);
    expect(snapshot.overagePriceCents).toBe(1500);
    expect(snapshot.overageUnits).toBe(2); // 3 - 1 = 2
    expect(snapshot.totalCents).toBe(1900 + 2 * 1500);
  });

  it('throws for unknown tier', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([
      {
        subscription_tier: 'enterprise',
        locations_included: 1,
        locations_paid: 0,
        locations_overage_price_cents: 2500,
      },
    ]);
    harness.sqlReturnQueue.push(mockLocationCount(1));

    await expect(currentBillingSnapshot(mockSql, accountId)).rejects.toThrow(
      /unknown subscription tier/i,
    );
  });

  it('throws when account not found', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([]); // no account found

    await expect(currentBillingSnapshot(mockSql, accountId)).rejects.toThrow(
      /account not found/i,
    );
  });

  it('keeps a stored zero-overage Copilot snapshot at zero even with extra locations', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 1, 0, 0),
    ]);

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    // Stored cents, not the live registry, remain authoritative.
    expect(snapshot.basePriceCents).toBe(2900);
    expect(snapshot.overagePriceCents).toBe(0);
    expect(snapshot.overageUnits).toBe(0);
    expect(snapshot.totalCents).toBe(2900);
    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('reads stored base_price_cents, not live TIER_CONFIG (founding price-lock)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Founding Copilot row whose stored base differs from the current registry.
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 1, 0, 2500, 1500),
    ]);
    harness.sqlReturnQueue.push(mockLocationCount(3)); // 2 overage units

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(1500);
    expect(snapshot.totalCents).toBe(1500 + 2 * 2500);
  });

  it('reads stored base_price_cents for a zero-overage Copilot snapshot', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Stored base differs from the current Copilot list price.
    harness.sqlReturnQueue.push([
      mockAccountRow('copilot', 1, 0, 0, 2600),
    ]);

    const snapshot = await currentBillingSnapshot(mockSql, accountId);

    expect(snapshot.basePriceCents).toBe(2600);
    expect(snapshot.totalCents).toBe(2600);
    expect(harness.sqlCalls).toHaveLength(1);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });
});

// ── assertCanAddLocation ────────────────────────────────────────────────────

// Helper to mock the account row that assertCanAddLocation expects from
// the account eligibility read (returns id, subscription_tier,
// subscription_status, locations_included, locations_paid).
function mockQuotaAccountRow(
  overrides: {
    tier?: SubscriptionTierValue;
    status?: string;
    locationsIncluded?: number;
    locationsPaid?: number;
  } = {},
) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    subscription_tier: overrides.tier ?? 'copilot',
    subscription_status: overrides.status ?? 'active',
    locations_included: overrides.locationsIncluded ?? 1,
    locations_paid: overrides.locationsPaid ?? 0,
  };
}

describe('assertCanAddLocation', () => {
  // Both launch tiers support one included location plus paid overage.
  it.each(['copilot', 'autopilot'] as const)('allows active %s accounts to add locations', async (tier) => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Account eligibility read
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier, status: 'active' })]);
    harness.sqlReturnQueue.push([{ count: 0 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(0);
    }
  });

  // VAL-LOC-002: rejects inactive subscription (all three inactive states)
  describe('rejects inactive subscriptions', () => {
    const inactiveStatuses = ['pending_payment', 'past_due', 'cancelled'] as const;

    for (const status of inactiveStatuses) {
      it(`rejects when subscription_status = '${status}'`, async () => {
        const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        harness.sqlReturnQueue.push([mockQuotaAccountRow({ status })]);

        const result = await assertCanAddLocation(mockSql, accountId);

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
          expect(result.reason).toBe('subscription_inactive');
        }
      });
    }
  });

  // VAL-LOC-003: quota boundary — at quota with overage policy → allows
  // For multi-location tiers, overage billing is automatic. The function
  // should allow the add and report overage units.
  it('at the Copilot quota boundary, allows with overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Account eligibility read
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 1, locationsPaid: 0 })]);
    // Location count query
    harness.sqlReturnQueue.push([{ count: 1 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(1);
    }
  });

  // VAL-LOC-003 variant: at quota with paid overage and multi-loc allowed
  // Even when locations_included + locations_paid == active count, overage
  // billing is automatic for multi-location tiers. The add is allowed with
  // the computed overage units.
  it('at quota boundary when locations_included + locations_paid == active count: allows with overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Copilot: 1 included, 2 paid, 3 active locations → at quota
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 1, locationsPaid: 2 })]);
    harness.sqlReturnQueue.push([{ count: 3 }]); // 1 + 2 = 3 active

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // 3 active + 1 new = 4 total, 1 included → 3 overage
      expect(result.overageUnits).toBe(3);
    }
  });

  // VAL-LOC-004: allows add when within quota
  it('uses a stored custom Autopilot quota when adding a location', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'autopilot', locationsIncluded: 5, locationsPaid: 0 })]);
    harness.sqlReturnQueue.push([{ count: 3 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(0);
    }
  });

  it('uses stored Copilot included quota when adding the second location', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 3, locationsPaid: 0 })]);
    harness.sqlReturnQueue.push([{ count: 1 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(0);
    }
  });

  it('uses stored Copilot included quota when adding the third location', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 3, locationsPaid: 0 })]);
    harness.sqlReturnQueue.push([{ count: 2 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(0);
    }
  });

  it('uses stored Copilot included quota when reporting overage above the custom quota', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 3, locationsPaid: 0 })]);
    harness.sqlReturnQueue.push([{ count: 5 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(3);
    }
  });

  // VAL-LOC-005: allows add with overage when above included quota but sub is active
  it('allows Copilot add with overage when above included quota', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 1, locationsPaid: 0 })]);
    harness.sqlReturnQueue.push([{ count: 1 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(1);
    }
  });

  // Autopilot with overage
  it('allows add with overage for Autopilot at a stored custom quota', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'autopilot', locationsIncluded: 5, locationsPaid: 0 })]);
    harness.sqlReturnQueue.push([{ count: 5 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(1);
    }
  });

  // Account not found
  it('rejects when account not found', async () => {
    const accountId = '00000000-0000-7f00-8000-000000000000';
    harness.sqlReturnQueue.push([]); // no account row

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('account_not_found');
    }
  });

  // Unknown tier
  it('rejects when subscription_tier is unknown', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([{
      id: accountId,
      subscription_tier: 'enterprise',
      subscription_status: 'active',
      locations_included: 1,
      locations_paid: 0,
    }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('tier_disallows_multi_location');
    }
  });

  // Edge: active count exceeds included + paid (oversold scenario)
  // Even when activeLocations > included + paid, the add is allowed
  // because overage billing is automatic for multi-location tiers.
  // The Stripe outbox worker will reconcile the overage quantity.
  it('allows even when active count > included + paid (oversold), with higher overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Copilot: 1 included, 1 paid → 2 max, but 3 active (oversold)
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 1, locationsPaid: 1 })]);
    harness.sqlReturnQueue.push([{ count: 3 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // 3 active + 1 new = 4 total, 1 included → 3 overage
      expect(result.overageUnits).toBe(3);
    }
  });

  // Edge: zero active locations but tier allows
  it('allows when zero active locations and tier allows multi-location', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot' })]);
    harness.sqlReturnQueue.push([{ count: 0 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(0);
    }
  });

  // Price variant does not alter Copilot location eligibility.
  it('allows add for founding Copilot', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot' })]);
    harness.sqlReturnQueue.push([{ count: 0 }]);

    const result = await assertCanAddLocation(mockSql, accountId);

    expect(result.allowed).toBe(true);
  });

  // ── Concurrent add simulation (VAL-LOC-006) ────────────────────────────
  //
  // assertCanAddLocation is an eligibility/quota-preview helper. It does
  // not hold row locks across the later INSERT because callers execute the
  // INSERT in a separate transaction. Billing consistency is handled by the
  // Stripe overage outbox worker, which reconciles from the actual active
  // location count.

  describe('concurrent add at quota boundary', () => {
    it('does not use standalone SELECT FOR UPDATE outside the add transaction', async () => {
      const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      harness.sqlReturnQueue.push([mockQuotaAccountRow()]);
      harness.sqlReturnQueue.push([{ count: 0 }]);

      await assertCanAddLocation(mockSql, accountId);

      const firstCall = harness.sqlCalls[0];
      expect(firstCall).toBeDefined();
      expect(firstCall!.text).not.toMatch(/\bFOR\s+UPDATE\b/i);
      expect(firstCall!.text).toContain('accounts');
    });

    it('structural: location count query filters archived_at IS NULL', async () => {
      const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      harness.sqlReturnQueue.push([mockQuotaAccountRow()]);
      harness.sqlReturnQueue.push([{ count: 0 }]);

      await assertCanAddLocation(mockSql, accountId);

      const secondCall = harness.sqlCalls[1];
      expect(secondCall).toBeDefined();
      expect(secondCall!.text).toContain('archived_at IS NULL');
    });

    it('computes overage from the latest active count it reads', async () => {
      // This test simulates the scenario described in VAL-LOC-006:
      // Two concurrent calls at the quota boundary would both read the same
      // account state (1 active, 1 included). The helper reports overage
      // for whatever active-location count it reads.
      const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      // Call A sees 1 active location at quota boundary → allowed with overage
      harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 1 })]);
      harness.sqlReturnQueue.push([{ count: 1 }]);
      const resultA = await assertCanAddLocation(mockSql, accountId);
      expect(resultA.allowed).toBe(true);
      if (resultA.allowed) {
        expect(resultA.overageUnits).toBe(1); // 1 active + 1 new = 2, over included=1 → 1 overage
      }

      // Call B sees the updated state if it runs after call A commits.
      harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 1 })]);
      harness.sqlReturnQueue.push([{ count: 2 }]); // After call A's add, now 2 active
      const resultB = await assertCanAddLocation(mockSql, accountId);
      expect(resultB.allowed).toBe(true);
      if (resultB.allowed) {
        expect(resultB.overageUnits).toBe(2); // 2 active + 1 new = 3, over included=1 → 2 overage
      }
    });

    it('allows concurrent same-state reads because overage billing has no hard cap', async () => {
      // Both calls may read the same state because this helper does not
      // serialize the later location INSERT.
      //
      // We can't test the actual lock in a unit test, but we demonstrate
      // that the business logic allows the current no-hard-cap overage policy.
      const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      // Both calls see the same state (simulating no lock / race condition)
      // Both would be allowed, but the second should see updated state
      // under the current no-hard-cap overage policy.
      harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 1 })]);
      harness.sqlReturnQueue.push([{ count: 1 }]);
      const result1 = await assertCanAddLocation(mockSql, accountId);
      expect(result1.allowed).toBe(true);

      harness.sqlReturnQueue.push([mockQuotaAccountRow({ tier: 'copilot', locationsIncluded: 1 })]);
      harness.sqlReturnQueue.push([{ count: 1 }]);
      const result2 = await assertCanAddLocation(mockSql, accountId);
      // Billing is reconciled asynchronously from the actual committed count.
      expect(result2.allowed).toBe(true);
    });
  });
});
