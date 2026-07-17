import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertStripePriceIdsUnique,
  basePriceIdSet,
  basePriceInfoForId,
  createPriceTierMap,
  isOveragePriceId,
  overagePriceIdSet,
  overagePriceIdForStoredCents,
  overagePriceInfoForId,
  priceIdFor,
  STRIPE_PRICE_ENV_VARS,
} from '../price-tier-map';

const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of STRIPE_PRICE_ENV_VARS) original[key] = process.env[key];
  process.env.STRIPE_PRICE_COPILOT_LIST = 'price_copilot_list';
  process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_copilot_founding';
  process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot_list';
  process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
  process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_copilot_overage';
  process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_autopilot_overage';
});

afterEach(() => {
  for (const key of STRIPE_PRICE_ENV_VARS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('price-tier-map', () => {
  it('owns exactly the six immutable launch Price variables', () => {
    expect(STRIPE_PRICE_ENV_VARS).toEqual([
      'STRIPE_PRICE_COPILOT_LIST',
      'STRIPE_PRICE_COPILOT_FOUNDING',
      'STRIPE_PRICE_AUTOPILOT_LIST',
      'STRIPE_PRICE_AUTOPILOT_FOUNDING',
      'STRIPE_PRICE_COPILOT_OVERAGE',
      'STRIPE_PRICE_AUTOPILOT_OVERAGE',
    ]);
  });

  it.each([
    ['copilot', 'list', 'price_copilot_list', 'price_copilot_overage'],
    ['copilot', 'founding', 'price_copilot_founding', 'price_copilot_overage'],
    ['autopilot', 'list', 'price_autopilot_list', 'price_autopilot_overage'],
    ['autopilot', 'founding', 'price_autopilot_founding', 'price_autopilot_overage'],
  ] as const)('resolves %s/%s base and overage IDs', (tier, variant, baseId, overageId) => {
    expect(priceIdFor(tier, variant, 'base')).toBe(baseId);
    expect(priceIdFor(tier, variant, 'overage')).toBe(overageId);
  });

  it('reverse-resolves every configured Price', () => {
    expect(basePriceInfoForId('price_copilot_list')).toEqual({ tier: 'copilot', variant: 'list' });
    expect(basePriceInfoForId('price_copilot_founding')).toEqual({ tier: 'copilot', variant: 'founding' });
    expect(basePriceInfoForId('price_autopilot_list')).toEqual({ tier: 'autopilot', variant: 'list' });
    expect(basePriceInfoForId('price_autopilot_founding')).toEqual({ tier: 'autopilot', variant: 'founding' });
    expect(overagePriceInfoForId('price_copilot_overage')).toEqual({ tier: 'copilot' });
    expect(overagePriceInfoForId('price_autopilot_overage')).toEqual({ tier: 'autopilot' });
  });

  it('retains rotated base and overage IDs for reverse lookup without replacing forward IDs', () => {
    const lookup = createPriceTierMap([
      {
        id: 'price_copilot_list_rotated_out',
        kind: 'base',
        tier: 'copilot',
        variant: 'list',
      },
      {
        id: 'price_copilot_overage_rotated_out',
        kind: 'overage',
        tier: 'copilot',
        unitAmountCents: 1250,
      },
    ]);

    expect(lookup.basePriceInfoForId('price_copilot_list_rotated_out')).toEqual({
      tier: 'copilot',
      variant: 'list',
    });
    expect(lookup.overagePriceInfoForId('price_copilot_overage_rotated_out')).toEqual({
      tier: 'copilot',
    });
    expect(lookup.overagePriceIdForStoredCents('copilot', 1250)).toBe(
      'price_copilot_overage_rotated_out',
    );
    expect(lookup.basePriceIdSet()).toContain('price_copilot_list_rotated_out');
    expect(lookup.overagePriceIdSet()).toContain('price_copilot_overage_rotated_out');

    // Historical IDs exist only for reverse recognition. New writes must keep
    // using the six live environment IDs.
    expect(lookup.priceIdFor('copilot', 'list', 'base')).toBe('price_copilot_list');
    expect(lookup.priceIdFor('copilot', 'list', 'overage')).toBe('price_copilot_overage');
  });

  it('allows retained history to repeat a current ID only with identical semantics', () => {
    const lookup = createPriceTierMap([
      {
        id: 'price_copilot_list',
        kind: 'base',
        tier: 'copilot',
        variant: 'list',
      },
    ]);

    expect(lookup.basePriceInfoForId('price_copilot_list')).toEqual({
      tier: 'copilot',
      variant: 'list',
    });
  });

  it('fails closed when retained history conflicts with a current Price mapping', () => {
    const lookup = createPriceTierMap([
      {
        id: 'price_copilot_list',
        kind: 'base',
        tier: 'autopilot',
        variant: 'list',
      },
    ]);

    expect(() => lookup.basePriceInfoForId('price_copilot_list')).toThrow(
      /price_copilot_list has conflicting mappings: base:copilot:list and base:autopilot:list/,
    );
  });

  it('fails closed when two retained entries conflict with each other', () => {
    const lookup = createPriceTierMap([
      {
        id: 'price_history_conflict',
        kind: 'base',
        tier: 'copilot',
        variant: 'founding',
      },
      {
        id: 'price_history_conflict',
        kind: 'overage',
        tier: 'copilot',
        unitAmountCents: 1500,
      },
    ]);

    expect(() => lookup.basePriceIdSet()).toThrow(
      /price_history_conflict has conflicting mappings: base:copilot:founding and overage:copilot/,
    );
  });

  it('resolves current overage cents from the live ID and never falls grandfathered cents forward', () => {
    expect(overagePriceIdForStoredCents('copilot', 1500)).toBe(
      'price_copilot_overage',
    );
    expect(overagePriceIdForStoredCents('copilot', 1400)).toBeNull();
  });

  it('rejects conflicting retained unit amounts for one immutable overage Price', () => {
    const lookup = createPriceTierMap([
      {
        id: 'price_old_overage',
        kind: 'overage',
        tier: 'copilot',
        unitAmountCents: 1400,
      },
      {
        id: 'price_old_overage',
        kind: 'overage',
        tier: 'copilot',
        unitAmountCents: 1450,
      },
    ]);

    expect(() => lookup.overagePriceIdForStoredCents('copilot', 1400)).toThrow(
      /price_old_overage has conflicting unit amounts: 1400 and 1450/,
    );
  });

  it('fails forward lookup closed when retained history conflicts with a live ID', () => {
    const lookup = createPriceTierMap([
      {
        id: 'price_copilot_list',
        kind: 'base',
        tier: 'autopilot',
        variant: 'founding',
      },
    ]);

    expect(() => lookup.priceIdFor('copilot', 'list', 'base')).toThrow(
      /price_copilot_list has conflicting mappings/,
    );
  });

  it('returns only canonical IDs from the base and overage sets', () => {
    expect(basePriceIdSet()).toEqual(new Set([
      'price_copilot_list',
      'price_copilot_founding',
      'price_autopilot_list',
      'price_autopilot_founding',
    ]));
    expect(overagePriceIdSet()).toEqual(new Set([
      'price_copilot_overage',
      'price_autopilot_overage',
    ]));
    expect(isOveragePriceId('price_copilot_overage')).toBe(true);
    expect(isOveragePriceId('price_copilot_list')).toBe(false);
  });

  it('fails closed for missing, blank, unknown, or malformed lookup inputs', () => {
    delete process.env.STRIPE_PRICE_COPILOT_LIST;
    process.env.STRIPE_PRICE_COPILOT_OVERAGE = '   ';
    expect(priceIdFor('copilot', 'list', 'base')).toBeNull();
    expect(priceIdFor('copilot', 'founding', 'overage')).toBeNull();
    expect(basePriceInfoForId('price_unknown')).toBeNull();
    expect(overagePriceInfoForId(null)).toBeNull();
    expect(() => priceIdFor('enterprise' as 'copilot', 'list', 'base')).toThrow(/Unknown WS8/);
    expect(() => priceIdFor('copilot', 'discount' as 'list', 'base')).toThrow(/variant/);
    expect(() => priceIdFor('copilot', 'list', 'annual' as 'base')).toThrow(/kind/);
  });

  it('rejects duplicate IDs across all six variables', () => {
    process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_copilot_list';
    expect(() => assertStripePriceIdsUnique()).toThrow(
      /STRIPE_PRICE_COPILOT_LIST duplicates STRIPE_PRICE_AUTOPILOT_OVERAGE/,
    );
  });
});
