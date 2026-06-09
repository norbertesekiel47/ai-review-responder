import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

import { currentBillingSnapshot } from '../quota';
import { sql } from '@/lib/db/server';
import { TIER_CONFIG } from '../tier-config';

// `sql` is Postgres.js's typed tagged-template fn; vi.mocked() re-applies that
// type, so mockResolvedValueOnce would reject plain row arrays (they lack the
// RowList/ResultQueryMeta fields). Cast the mocked ref to vitest's Mock so the
// resolved value is unconstrained — runtime is the vi.fn() from the mock above.
const sqlMock = sql as unknown as Mock;
afterEach(() => sqlMock.mockReset());

describe('currentBillingSnapshot grandfathering (invariant #9a)', () => {
  it('basic: returns the STORED base price, not live TIER_CONFIG', async () => {
    expect(TIER_CONFIG.basic.baseCents).toBe(2900); // current published price
    sqlMock.mockResolvedValueOnce([{
      subscription_tier: 'basic',
      locations_included: 1,
      locations_paid: 1,
      locations_overage_price_cents: 0,
      base_price_cents: 1900, // grandfathered — older, lower price
    }]);

    const snap = await currentBillingSnapshot('acct_1');
    expect(snap.basePriceCents).toBe(1900);   // STORED, not 2900
    expect(snap.totalCents).toBe(1900);
    expect(snap.overageUnits).toBe(0);
    expect(sqlMock).toHaveBeenCalledTimes(1); // basic short-circuits (no location-count query)
  });

  it('standard: stored base + stored overage price drive the total, ignoring live TIER_CONFIG', async () => {
    expect(TIER_CONFIG.standard.baseCents).toBe(7900);
    expect(TIER_CONFIG.standard.overageCents).toBe(2500);
    sqlMock
      .mockResolvedValueOnce([{
        subscription_tier: 'standard',
        locations_included: 1,
        locations_paid: 2,
        locations_overage_price_cents: 2000, // grandfathered overage (≠ 2500)
        base_price_cents: 6900,              // grandfathered base    (≠ 7900)
      }])
      .mockResolvedValueOnce([{ count: 2 }]); // 2 active locations → 1 overage unit

    const snap = await currentBillingSnapshot('acct_2');
    expect(snap.basePriceCents).toBe(6900);        // STORED
    expect(snap.overagePriceCents).toBe(2000);     // STORED
    expect(snap.overageUnits).toBe(1);             // 2 - 1
    expect(snap.totalCents).toBe(6900 + 1 * 2000); // 8900 — all grandfathered
  });
});
