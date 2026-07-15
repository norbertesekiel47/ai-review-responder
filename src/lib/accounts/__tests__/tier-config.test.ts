// src/lib/accounts/__tests__/tier-config.test.ts
//
// TDD assertions for central SubscriptionTier type/const and tier config map.
// Validation contract: VAL-BILLING-028, VAL-BILLING-029, VAL-BILLING-042.

import { describe, it, expect } from 'vitest';
import {
  SubscriptionTier,
  type SubscriptionTierValue,
  type TransitionSubscriptionTierValue,
  isSubscriptionTier,
  TIER_CONFIG,
  getTierConfig,
  lookupTierConfig,
  resolveTierSnapshot,
} from '../tier-config';

// ── SubscriptionTier const ───────────────────────────────────────────────────

describe('SubscriptionTier', () => {
  it('contains the two WS8 tiers', () => {
    expect(SubscriptionTier.COPILOT).toBe('copilot');
    expect(SubscriptionTier.AUTOPILOT).toBe('autopilot');
  });

  it('contains basic', () => {
    expect(SubscriptionTier.BASIC).toBe('basic');
  });

  it('contains standard', () => {
    expect(SubscriptionTier.STANDARD).toBe('standard');
  });

  it('contains premium', () => {
    expect(SubscriptionTier.PREMIUM).toBe('premium');
  });

  it('contains founders (not founding)', () => {
    // Per spec: 'founding' → 'founders' in the tier table
    expect(SubscriptionTier.FOUNDERS).toBe('founders');
  });

  it('has 2 WS8 tiers plus 4 WS8_TRANSITION_ONLY legacy values', () => {
    const values = Object.values(SubscriptionTier);
    expect(values).toHaveLength(6);
  });

  it('all values are strings', () => {
    const values = Object.values(SubscriptionTier);
    for (const v of values) {
      expect(typeof v).toBe('string');
    }
  });

  it('SubscriptionTierValue type is derived from const (compile-time check)', () => {
    const t: SubscriptionTierValue = 'standard';
    expect(typeof t).toBe('string');
  });
});

// ── isSubscriptionTier type guard ───────────────────────────────────────────

describe('isSubscriptionTier', () => {
  it('returns true for WS8 tiers and transition-only legacy tiers', () => {
    expect(isSubscriptionTier('copilot')).toBe(true);
    expect(isSubscriptionTier('autopilot')).toBe(true);
    expect(isSubscriptionTier('basic')).toBe(true);
    expect(isSubscriptionTier('standard')).toBe(true);
    expect(isSubscriptionTier('premium')).toBe(true);
    expect(isSubscriptionTier('founders')).toBe(true);
  });

  it('returns false for the legacy "founding" value', () => {
    // 'founding' was the old name; it is NOT a valid SubscriptionTierValue
    expect(isSubscriptionTier('founding')).toBe(false);
  });

  it('returns false for unknown strings', () => {
    expect(isSubscriptionTier('enterprise')).toBe(false);
    expect(isSubscriptionTier('')).toBe(false);
    expect(isSubscriptionTier('free')).toBe(false);
  });

  it('narrows the type when true', () => {
    const value: string = 'standard';
    if (isSubscriptionTier(value)) {
      const _typed: TransitionSubscriptionTierValue = value;
      expect(_typed).toBe('standard');
    }
  });
});

// ── Tier config map (VAL-BILLING-028) ───────────────────────────────────────

describe('TIER_CONFIG', () => {
  it('has entries for both WS8 tiers and all transition-only tiers', () => {
    const keys = Object.keys(TIER_CONFIG) as SubscriptionTierValue[];
    expect(keys).toHaveLength(6);
    expect(keys).toContain('copilot');
    expect(keys).toContain('autopilot');
    expect(keys).toContain('basic');
    expect(keys).toContain('standard');
    expect(keys).toContain('premium');
    expect(keys).toContain('founders');
  });

  it.each([
    ['copilot', 'list', 2900, 1500, 1],
    ['copilot', 'founding', 1900, 1500, 1],
    ['autopilot', 'list', 6900, 2000, 1],
    ['autopilot', 'founding', 4900, 2000, 1],
  ] as const)(
    'resolves %s/%s to the exact complete write snapshot',
    (tier, variant, baseCents, overageCents, included) => {
      expect(resolveTierSnapshot(tier, variant)).toEqual({
        tier,
        variant,
        baseCents,
        overageCents,
        included,
      });
      expect(TIER_CONFIG[tier].multiLocAllowed).toBe(true);
    },
  );

  it('has no legacy-tier or unknown fallback in the WS8 resolver', () => {
    expect(() =>
      resolveTierSnapshot('standard' as 'copilot', 'list'),
    ).toThrow(/Unknown WS8 subscription tier/);
    expect(() =>
      resolveTierSnapshot('copilot', 'discounted' as 'list'),
    ).toThrow(/Unknown price variant/);
  });

  // ── basic tier ──────────────────────────────────────────────────────────

  describe('basic tier', () => {
    const config = TIER_CONFIG.basic;

    it('baseCents = 2900 ($29/mo)', () => {
      expect(config.baseCents).toBe(2900);
    });

    it('included = 1 (single-location only)', () => {
      expect(config.included).toBe(1);
    });

    it('overageCents = 0 (no overage)', () => {
      expect(config.overageCents).toBe(0);
    });

    it('multiLocAllowed = false', () => {
      expect(config.multiLocAllowed).toBe(false);
    });
  });

  // ── standard tier ───────────────────────────────────────────────────────

  describe('standard tier', () => {
    const config = TIER_CONFIG.standard;

    it('baseCents = 7900 ($79/mo)', () => {
      expect(config.baseCents).toBe(7900);
    });

    it('included = 1', () => {
      expect(config.included).toBe(1);
    });

    it('overageCents = 2500 ($25/mo per unit)', () => {
      expect(config.overageCents).toBe(2500);
    });

    it('multiLocAllowed = true', () => {
      expect(config.multiLocAllowed).toBe(true);
    });
  });

  // ── premium tier ────────────────────────────────────────────────────────

  describe('premium tier', () => {
    const config = TIER_CONFIG.premium;

    it('baseCents = 19900 ($199/mo)', () => {
      expect(config.baseCents).toBe(19900);
    });

    it('included = 5', () => {
      expect(config.included).toBe(5);
    });

    it('overageCents = 2000 ($20/mo per unit)', () => {
      expect(config.overageCents).toBe(2000);
    });

    it('multiLocAllowed = true', () => {
      expect(config.multiLocAllowed).toBe(true);
    });
  });

  // ── founders tier ───────────────────────────────────────────────────────

  describe('founders tier', () => {
    const config = TIER_CONFIG.founders;

    it('baseCents = 1900 ($19/mo)', () => {
      expect(config.baseCents).toBe(1900);
    });

    it('included = 1', () => {
      expect(config.included).toBe(1);
    });

    it('overageCents = 2500 ($25/mo per unit)', () => {
      expect(config.overageCents).toBe(2500);
    });

    it('multiLocAllowed = true', () => {
      expect(config.multiLocAllowed).toBe(true);
    });
  });
});

// ── getTierConfig (VAL-BILLING-029) ─────────────────────────────────────────

describe('getTierConfig', () => {
  it('returns config for each valid tier', () => {
    expect(getTierConfig('copilot')).toBe(TIER_CONFIG.copilot);
    expect(getTierConfig('autopilot')).toBe(TIER_CONFIG.autopilot);
    expect(getTierConfig('basic')).toBe(TIER_CONFIG.basic);
    expect(getTierConfig('standard')).toBe(TIER_CONFIG.standard);
    expect(getTierConfig('premium')).toBe(TIER_CONFIG.premium);
    expect(getTierConfig('founders')).toBe(TIER_CONFIG.founders);
  });
});

// ── lookupTierConfig ────────────────────────────────────────────────────────

describe('lookupTierConfig', () => {
  it('returns config for valid tiers', () => {
    expect(lookupTierConfig('standard')).toEqual(TIER_CONFIG.standard);
  });

  it('returns undefined for unknown tier', () => {
    expect(lookupTierConfig('enterprise')).toBeUndefined();
    expect(lookupTierConfig('founding')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(lookupTierConfig('')).toBeUndefined();
  });
});
