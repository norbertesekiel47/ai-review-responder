import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertStripePriceIdsUnique,
  basePriceInfoForId,
  basePriceIdForTier,
  basePriceIdSet,
  overagePriceInfoForId,
  overagePriceIdForTier,
  priceIdFor,
  STRIPE_PRICE_ENV_VARS,
  tierForBasePriceId,
  isOveragePriceId,
  overagePriceIdSet,
} from '../price-tier-map';

const PRICE_KEYS = [
  ...STRIPE_PRICE_ENV_VARS,
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_STANDARD',
  'STRIPE_PRICE_PREMIUM',
  'STRIPE_PRICE_STANDARD_OVERAGE',
  'STRIPE_PRICE_PREMIUM_OVERAGE',
  'STRIPE_PRICE_FOUNDERS_OVERAGE',
] as const;

const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of PRICE_KEYS) original[k] = process.env[k];
  for (const k of STRIPE_PRICE_ENV_VARS) delete process.env[k];
  process.env.STRIPE_PRICE_BASIC = 'price_basic';
  process.env.STRIPE_PRICE_FOUNDING = 'price_founders';
  process.env.STRIPE_PRICE_STANDARD = 'price_standard';
  process.env.STRIPE_PRICE_PREMIUM = 'price_premium';
  process.env.STRIPE_PRICE_STANDARD_OVERAGE = 'price_standard_overage';
  process.env.STRIPE_PRICE_PREMIUM_OVERAGE = 'price_premium_overage';
  process.env.STRIPE_PRICE_FOUNDERS_OVERAGE = 'price_founders_overage';
});

afterEach(() => {
  for (const k of PRICE_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe('price-tier-map', () => {
  describe('WS8 variant-aware map', () => {
    beforeEach(() => {
      process.env.STRIPE_PRICE_COPILOT_LIST = 'price_copilot_list';
      process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_copilot_founding';
      process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot_list';
      process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
      process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_copilot_overage';
      process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_autopilot_overage';
    });

    it('owns exactly the six locked launch variables', () => {
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
    ] as const)(
      'resolves %s/%s base and variant-required overage',
      (tier, variant, baseId, overageId) => {
        expect(priceIdFor(tier, variant, 'base')).toBe(baseId);
        expect(priceIdFor(tier, variant, 'overage')).toBe(overageId);
      },
    );

    it('reverse-resolves all four base Prices and both overage Prices', () => {
      expect(basePriceInfoForId('price_copilot_list')).toEqual({
        tier: 'copilot', variant: 'list',
      });
      expect(basePriceInfoForId('price_copilot_founding')).toEqual({
        tier: 'copilot', variant: 'founding',
      });
      expect(basePriceInfoForId('price_autopilot_list')).toEqual({
        tier: 'autopilot', variant: 'list',
      });
      expect(basePriceInfoForId('price_autopilot_founding')).toEqual({
        tier: 'autopilot', variant: 'founding',
      });
      expect(overagePriceInfoForId('price_copilot_overage')).toEqual({ tier: 'copilot' });
      expect(overagePriceInfoForId('price_autopilot_overage')).toEqual({ tier: 'autopilot' });
    });

    it('fails closed for missing, blank, and unknown IDs', () => {
      delete process.env.STRIPE_PRICE_COPILOT_LIST;
      process.env.STRIPE_PRICE_COPILOT_OVERAGE = '   ';
      expect(priceIdFor('copilot', 'list', 'base')).toBeNull();
      expect(priceIdFor('copilot', 'founding', 'overage')).toBeNull();
      expect(basePriceInfoForId('price_unknown')).toBeNull();
      expect(basePriceInfoForId('')).toBeNull();
      expect(basePriceInfoForId(undefined)).toBeNull();
      expect(overagePriceInfoForId(null)).toBeNull();
    });

    it('rejects unknown tier, variant, and kind without a fallback', () => {
      expect(() => priceIdFor('standard' as 'copilot', 'list', 'base')).toThrow(
        /Unknown WS8 subscription tier/,
      );
      expect(() => priceIdFor('copilot', 'discount' as 'list', 'base')).toThrow(
        /Unknown price variant/,
      );
      expect(() => priceIdFor('copilot', 'list', 'annual' as 'base')).toThrow(
        /Unknown Stripe Price kind/,
      );
    });

    it('rejects duplicate IDs across base and overage configuration', () => {
      process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_copilot_list';
      expect(() => assertStripePriceIdsUnique()).toThrow(
        /STRIPE_PRICE_COPILOT_LIST duplicates STRIPE_PRICE_AUTOPILOT_OVERAGE/,
      );
      expect(() => basePriceInfoForId('price_copilot_list')).toThrow(/must be unique/);
    });

    it('includes every configured WS8 Price in the canonical sets', () => {
      expect(basePriceIdSet()).toEqual(new Set([
        'price_copilot_list',
        'price_copilot_founding',
        'price_autopilot_list',
        'price_autopilot_founding',
        'price_basic',
        'price_standard',
        'price_premium',
        'price_founders',
      ]));
      expect(overagePriceIdSet()).toEqual(new Set([
        'price_copilot_overage',
        'price_autopilot_overage',
        'price_standard_overage',
        'price_premium_overage',
        'price_founders_overage',
      ]));
    });
  });

  describe('basePriceIdForTier', () => {
    it('maps each tier to its base price ID', () => {
      expect(basePriceIdForTier('basic')).toBe('price_basic');
      expect(basePriceIdForTier('standard')).toBe('price_standard');
      expect(basePriceIdForTier('premium')).toBe('price_premium');
      expect(basePriceIdForTier('founders')).toBe('price_founders');
    });
    it('returns null when the env var is unset', () => {
      delete process.env.STRIPE_PRICE_STANDARD;
      expect(basePriceIdForTier('standard')).toBeNull();
    });
  });

  describe('overagePriceIdForTier', () => {
    it('maps non-basic tiers to overage price IDs; basic is null', () => {
      expect(overagePriceIdForTier('basic')).toBeNull();
      expect(overagePriceIdForTier('standard')).toBe('price_standard_overage');
      expect(overagePriceIdForTier('premium')).toBe('price_premium_overage');
      expect(overagePriceIdForTier('founders')).toBe('price_founders_overage');
    });
    it('returns null when the overage env var is unset', () => {
      delete process.env.STRIPE_PRICE_STANDARD_OVERAGE;
      expect(overagePriceIdForTier('standard')).toBeNull();
    });
  });

  describe('tierForBasePriceId (reverse map)', () => {
    it('maps each base price ID back to its tier', () => {
      expect(tierForBasePriceId('price_basic')).toBe('basic');
      expect(tierForBasePriceId('price_standard')).toBe('standard');
      expect(tierForBasePriceId('price_premium')).toBe('premium');
      expect(tierForBasePriceId('price_founders')).toBe('founders');
    });
    it('returns null for an unknown price ID', () => {
      expect(tierForBasePriceId('price_unknown')).toBeNull();
    });
    it('returns null for empty/undefined/null input (no empty-string key collision)', () => {
      expect(tierForBasePriceId('')).toBeNull();
      expect(tierForBasePriceId(undefined)).toBeNull();
      expect(tierForBasePriceId(null)).toBeNull();
    });
    it('does not collide when multiple base price vars are unset', () => {
      delete process.env.STRIPE_PRICE_BASIC;
      delete process.env.STRIPE_PRICE_STANDARD;
      expect(tierForBasePriceId('')).toBeNull();
      expect(tierForBasePriceId('price_premium')).toBe('premium');
    });
  });

  describe('basePriceIdSet', () => {
    it('contains the configured base price IDs only', () => {
      const set = basePriceIdSet();
      expect(set.has('price_basic')).toBe(true);
      expect(set.has('price_standard')).toBe(true);
      expect(set.has('price_premium')).toBe(true);
      expect(set.has('price_founders')).toBe(true);
      expect(set.has('')).toBe(false);
      expect(set.size).toBe(4);
    });
    it('excludes unset base vars from the set', () => {
      delete process.env.STRIPE_PRICE_STANDARD;
      const set = basePriceIdSet();
      expect(set.has('price_standard')).toBe(false);
      expect(set.size).toBe(3);
    });
  });

  describe('overagePriceIdSet / isOveragePriceId', () => {
    it('contains the configured overage IDs only', () => {
      const set = overagePriceIdSet();
      expect(set.has('price_standard_overage')).toBe(true);
      expect(set.has('price_premium_overage')).toBe(true);
      expect(set.has('price_founders_overage')).toBe(true);
      expect(set.has('')).toBe(false);
      expect(set.size).toBe(3);
    });
    it('isOveragePriceId reflects membership', () => {
      expect(isOveragePriceId('price_standard_overage')).toBe(true);
      expect(isOveragePriceId('price_basic')).toBe(false);
      expect(isOveragePriceId('')).toBe(false);
      expect(isOveragePriceId(undefined)).toBe(false);
    });
    it('excludes unset overage vars from the set', () => {
      delete process.env.STRIPE_PRICE_STANDARD_OVERAGE;
      const set = overagePriceIdSet();
      expect(set.has('price_standard_overage')).toBe(false);
      expect(set.size).toBe(2);
    });
  });
});
