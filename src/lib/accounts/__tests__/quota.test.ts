// src/lib/accounts/__tests__/quota.test.ts
//
// TDD assertions for computeOverageQuantity and currentBillingSnapshot.
// Validation contract: VAL-BILLING-017 through VAL-BILLING-027.

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
