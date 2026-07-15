import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertStripePriceIdsUnique,
  basePriceIdSet,
  basePriceInfoForId,
  isOveragePriceId,
  overagePriceIdSet,
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
