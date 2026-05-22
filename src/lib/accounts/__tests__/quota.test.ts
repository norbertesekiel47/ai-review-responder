// src/lib/accounts/__tests__/quota.test.ts
//
// TDD assertions for computeOverageQuantity, currentBillingSnapshot,
// and assertCanAddLocation.
// Validation contract: VAL-BILLING-017 through VAL-BILLING-027,
// VAL-LOC-001 through VAL-LOC-006.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SubscriptionTierValue } from '../tier-config';

// ── Hoisted mock for sql ────────────────────────────────────────────────
// Must be hoisted so vi.mock factory can reference it at the top of the file.

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

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

// ── currentBillingSnapshot ─────────────────────────────────────────────────

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

// Helper to build the account row that currentBillingSnapshot expects
function mockAccountRow(
  tier: SubscriptionTierValue,
  locationsIncluded: number,
  locationsPaid: number,
) {
  return {
    subscription_tier: tier,
    locations_included: locationsIncluded,
    locations_paid: locationsPaid,
  };
}

// Helper to mock the active location count query
function mockLocationCount(count: number) {
  return [{ count }];
}

describe('currentBillingSnapshot', () => {
  // VAL-BILLING-024 — standard tier
  it('returns correct snapshot for standard tier with overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // First query returns account row
    mockSql.mockResolvedValueOnce([
      mockAccountRow('standard', 1, 3),
    ]);
    // Second query returns active location count
    mockSql.mockResolvedValueOnce(mockLocationCount(4));

    const snapshot = await currentBillingSnapshot(accountId);

    expect(snapshot.basePriceCents).toBe(7900);
    expect(snapshot.includedLocations).toBe(1);
    expect(snapshot.overagePriceCents).toBe(2500);
    expect(snapshot.overageUnits).toBe(3); // 4 - 1 = 3
    expect(snapshot.totalCents).toBe(7900 + 3 * 2500); // 15400
  });

  // VAL-BILLING-025 — basic tier, no overage
  it('returns no overage for basic tier', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      mockAccountRow('basic', 1, 0),
    ]);
    mockSql.mockResolvedValueOnce(mockLocationCount(1));

    const snapshot = await currentBillingSnapshot(accountId);

    expect(snapshot.basePriceCents).toBe(2900);
    expect(snapshot.includedLocations).toBe(1);
    expect(snapshot.overagePriceCents).toBe(0);
    expect(snapshot.overageUnits).toBe(0);
    expect(snapshot.totalCents).toBe(2900);
  });

  // VAL-BILLING-026 — premium tier with 5 included
  it('returns correct snapshot for premium tier with 5 included', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      mockAccountRow('premium', 5, 0),
    ]);
    mockSql.mockResolvedValueOnce(mockLocationCount(7));

    const snapshot = await currentBillingSnapshot(accountId);

    expect(snapshot.basePriceCents).toBe(19900);
    expect(snapshot.includedLocations).toBe(5);
    expect(snapshot.overagePriceCents).toBe(2000);
    expect(snapshot.overageUnits).toBe(2); // 7 - 5 = 2
    expect(snapshot.totalCents).toBe(19900 + 2 * 2000); // 23900
  });

  // VAL-BILLING-027 — founders tier
  it('returns correct snapshot for founders tier', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      mockAccountRow('founders', 1, 0),
    ]);
    mockSql.mockResolvedValueOnce(mockLocationCount(3));

    const snapshot = await currentBillingSnapshot(accountId);

    expect(snapshot.basePriceCents).toBe(1900);
    expect(snapshot.includedLocations).toBe(1);
    expect(snapshot.overagePriceCents).toBe(2500);
    expect(snapshot.overageUnits).toBe(2); // 3 - 1 = 2
    expect(snapshot.totalCents).toBe(1900 + 2 * 2500); // 6900
  });

  it('throws for unknown tier', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      { subscription_tier: 'enterprise', locations_included: 1, locations_paid: 0 },
    ]);
    mockSql.mockResolvedValueOnce(mockLocationCount(1));

    await expect(currentBillingSnapshot(accountId)).rejects.toThrow(
      /unknown subscription tier/i,
    );
  });

  it('throws when account not found', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([]); // no account found

    await expect(currentBillingSnapshot(accountId)).rejects.toThrow(
      /account not found/i,
    );
  });

  it('basic tier with 0 overage even if extra locations exist (impossible scenario, but tested)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([
      mockAccountRow('basic', 1, 0),
    ]);
    mockSql.mockResolvedValueOnce(mockLocationCount(3));

    const snapshot = await currentBillingSnapshot(accountId);

    // Basic tier has overageCents=0 and multiLocAllowed=false
    // The snapshot reports 0 overage regardless
    expect(snapshot.basePriceCents).toBe(2900);
    expect(snapshot.overagePriceCents).toBe(0);
    expect(snapshot.overageUnits).toBe(0);
    expect(snapshot.totalCents).toBe(2900);
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
    subscription_tier: overrides.tier ?? 'standard',
    subscription_status: overrides.status ?? 'active',
    locations_included: overrides.locationsIncluded ?? 1,
    locations_paid: overrides.locationsPaid ?? 0,
  };
}

describe('assertCanAddLocation', () => {
  // VAL-LOC-001: rejects basic tier (multiLocAllowed = false)
  it('rejects basic tier accounts (multiLocAllowed = false)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Account eligibility read
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'basic', status: 'active' })]);

    const result = await assertCanAddLocation(accountId);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('tier_disallows_multi_location');
    }
  });

  // VAL-LOC-002: rejects inactive subscription (all three inactive states)
  describe('rejects inactive subscriptions', () => {
    const inactiveStatuses = ['pending_payment', 'past_due', 'cancelled'] as const;

    for (const status of inactiveStatuses) {
      it(`rejects when subscription_status = '${status}'`, async () => {
        const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ status })]);

        const result = await assertCanAddLocation(accountId);

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
  it('at quota boundary (standard, 1 included, 0 paid, 1 active): allows with overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // Account eligibility read
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard', locationsIncluded: 1, locationsPaid: 0 })]);
    // Location count query
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    const result = await assertCanAddLocation(accountId);

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
    // Standard tier: 1 included, 2 paid, 3 active locations → at quota
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard', locationsIncluded: 1, locationsPaid: 2 })]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // 1 + 2 = 3 active

    const result = await assertCanAddLocation(accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // 3 active + 1 new = 4 total, 1 included → 3 overage
      expect(result.overageUnits).toBe(3);
    }
  });

  // VAL-LOC-004: allows add when within quota
  it('allows add when within quota (premium, 5 included, 3 active)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'premium', locationsIncluded: 5, locationsPaid: 0 })]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]);

    const result = await assertCanAddLocation(accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(0);
    }
  });

  // VAL-LOC-005: allows add with overage when above included quota but sub is active
  it('allows add with overage when above included quota (standard, 1 included, 0 paid, 1 active)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard', locationsIncluded: 1, locationsPaid: 0 })]);
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    const result = await assertCanAddLocation(accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(1);
    }
  });

  // Premium tier with overage
  it('allows add with overage for premium at quota (5 included, 5 active)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'premium', locationsIncluded: 5, locationsPaid: 0 })]);
    mockSql.mockResolvedValueOnce([{ count: 5 }]);

    const result = await assertCanAddLocation(accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(1);
    }
  });

  // Account not found
  it('rejects when account not found', async () => {
    const accountId = '00000000-0000-7f00-8000-000000000000';
    mockSql.mockResolvedValueOnce([]); // no account row

    const result = await assertCanAddLocation(accountId);

    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('account_not_found');
    }
  });

  // Unknown tier
  it('rejects when subscription_tier is unknown', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([{
      id: accountId,
      subscription_tier: 'enterprise',
      subscription_status: 'active',
      locations_included: 1,
      locations_paid: 0,
    }]);

    const result = await assertCanAddLocation(accountId);

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
    // Standard: 1 included, 1 paid → 2 max, but 3 active (oversold)
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard', locationsIncluded: 1, locationsPaid: 1 })]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]);

    const result = await assertCanAddLocation(accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      // 3 active + 1 new = 4 total, 1 included → 3 overage
      expect(result.overageUnits).toBe(3);
    }
  });

  // Edge: zero active locations but tier allows
  it('allows when zero active locations and tier allows multi-location', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard' })]);
    mockSql.mockResolvedValueOnce([{ count: 0 }]);

    const result = await assertCanAddLocation(accountId);

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.overageUnits).toBe(0);
    }
  });

  // Founders tier allows multi-location
  it('allows add for founders tier (multiLocAllowed = true)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'founders' })]);
    mockSql.mockResolvedValueOnce([{ count: 0 }]);

    const result = await assertCanAddLocation(accountId);

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
      mockSql.mockResolvedValueOnce([mockQuotaAccountRow()]);
      mockSql.mockResolvedValueOnce([{ count: 0 }]);

      await assertCanAddLocation(accountId);

      const firstCall = mockSql.mock.calls[0];
      expect(firstCall).toBeDefined();
      const template = (firstCall![0] as TemplateStringsArray).join('?');
      expect(template).not.toMatch(/\bFOR\s+UPDATE\b/i);
      expect(template).toContain('accounts');
    });

    it('structural: location count query filters archived_at IS NULL', async () => {
      const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      mockSql.mockResolvedValueOnce([mockQuotaAccountRow()]);
      mockSql.mockResolvedValueOnce([{ count: 0 }]);

      await assertCanAddLocation(accountId);

      const secondCall = mockSql.mock.calls[1];
      expect(secondCall).toBeDefined();
      const template = (secondCall![0] as TemplateStringsArray).join('?');
      expect(template).toContain('archived_at IS NULL');
    });

    it('computes overage from the latest active count it reads', async () => {
      // This test simulates the scenario described in VAL-LOC-006:
      // Two concurrent calls at the quota boundary would both read the same
      // account state (1 active, 1 included). The helper reports overage
      // for whatever active-location count it reads.
      const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

      // Call A sees 1 active location at quota boundary → allowed with overage
      mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard', locationsIncluded: 1 })]);
      mockSql.mockResolvedValueOnce([{ count: 1 }]);
      const resultA = await assertCanAddLocation(accountId);
      expect(resultA.allowed).toBe(true);
      if (resultA.allowed) {
        expect(resultA.overageUnits).toBe(1); // 1 active + 1 new = 2, over included=1 → 1 overage
      }

      // Call B sees the updated state if it runs after call A commits.
      mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard', locationsIncluded: 1 })]);
      mockSql.mockResolvedValueOnce([{ count: 2 }]); // After call A's add, now 2 active
      const resultB = await assertCanAddLocation(accountId);
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
      mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard', locationsIncluded: 1 })]);
      mockSql.mockResolvedValueOnce([{ count: 1 }]);
      const result1 = await assertCanAddLocation(accountId);
      expect(result1.allowed).toBe(true);

      mockSql.mockResolvedValueOnce([mockQuotaAccountRow({ tier: 'standard', locationsIncluded: 1 })]);
      mockSql.mockResolvedValueOnce([{ count: 1 }]);
      const result2 = await assertCanAddLocation(accountId);
      // Billing is reconciled asynchronously from the actual committed count.
      expect(result2.allowed).toBe(true);
    });
  });
});
