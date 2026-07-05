import { afterEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

import { currentBillingSnapshot } from '../quota';
import { TIER_CONFIG } from '../tier-config';

// quota.ts is born-injected (sql is a parameter, A+ campaign PR 2b), so
// @/lib/db/server no longer needs mocking here — the fragment-aware
// createMockSql harness stands in for `sql` directly.

const harness: MockSqlHarness = createMockSql();
const mockSql = harness.mockSql as unknown as Sql;
afterEach(() => harness.resetMockSql());

describe('currentBillingSnapshot grandfathering (invariant #9a)', () => {
  it('basic: returns the STORED base price, not live TIER_CONFIG', async () => {
    expect(TIER_CONFIG.basic.baseCents).toBe(2900); // current published price
    harness.sqlReturnQueue.push([{
      subscription_tier: 'basic',
      locations_included: 1,
      locations_paid: 1,
      locations_overage_price_cents: 0,
      base_price_cents: 1900, // grandfathered — older, lower price
    }]);

    const snap = await currentBillingSnapshot(mockSql, 'acct_1');
    expect(snap.basePriceCents).toBe(1900);   // STORED, not 2900
    expect(snap.totalCents).toBe(1900);
    expect(snap.overageUnits).toBe(0);
    expect(harness.sqlCalls).toHaveLength(1); // basic short-circuits (no location-count query)
  });

  it('standard: stored base + stored overage price drive the total, ignoring live TIER_CONFIG', async () => {
    expect(TIER_CONFIG.standard.baseCents).toBe(7900);
    expect(TIER_CONFIG.standard.overageCents).toBe(2500);
    harness.sqlReturnQueue.push([{
      subscription_tier: 'standard',
      locations_included: 1,
      locations_paid: 2,
      locations_overage_price_cents: 2000, // grandfathered overage (≠ 2500)
      base_price_cents: 6900,              // grandfathered base    (≠ 7900)
    }]);
    harness.sqlReturnQueue.push([{ count: 2 }]); // 2 active locations → 1 overage unit

    const snap = await currentBillingSnapshot(mockSql, 'acct_2');
    expect(snap.basePriceCents).toBe(6900);        // STORED
    expect(snap.overagePriceCents).toBe(2000);     // STORED
    expect(snap.overageUnits).toBe(1);             // 2 - 1
    expect(snap.totalCents).toBe(6900 + 1 * 2000); // 8900 — all grandfathered
  });
});
