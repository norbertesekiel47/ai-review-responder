import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  basePriceIdForTier,
  overagePriceIdForTier,
  tierForBasePriceId,
  isOveragePriceId,
  overagePriceIdSet,
} from '../price-tier-map';

const PRICE_KEYS = [
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
