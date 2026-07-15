import { describe, expect, it } from 'vitest';
import {
  SubscriptionTier,
  type SubscriptionTierValue,
  getTierConfig,
  isPriceVariant,
  isSubscriptionTier,
  lookupTierConfig,
  resolveTierSnapshot,
  TIER_CONFIG,
} from '../tier-config';

describe('SubscriptionTier', () => {
  it('contains exactly the two launch tiers', () => {
    expect(SubscriptionTier).toEqual({
      COPILOT: 'copilot',
      AUTOPILOT: 'autopilot',
    });
  });

  it('derives the canonical type from the const', () => {
    const tier: SubscriptionTierValue = SubscriptionTier.COPILOT;
    expect(tier).toBe('copilot');
  });
});

describe('tier guards', () => {
  it.each(['copilot', 'autopilot'])('accepts %s', (tier) => {
    expect(isSubscriptionTier(tier)).toBe(true);
  });

  it.each(['starter', 'growth', 'elite', 'early_access', 'enterprise', ''])(
    'rejects removed or unknown tier %s',
    (tier) => {
      expect(isSubscriptionTier(tier)).toBe(false);
      expect(lookupTierConfig(tier)).toBeUndefined();
    },
  );

  it.each(['list', 'founding'])('accepts price variant %s independently', (variant) => {
    expect(isPriceVariant(variant)).toBe(true);
  });
});

describe('TIER_CONFIG', () => {
  it('contains only the launch tiers', () => {
    expect(Object.keys(TIER_CONFIG)).toEqual(['copilot', 'autopilot']);
  });

  it.each([
    ['copilot', 'list', 2900, 1500, 1],
    ['copilot', 'founding', 1900, 1500, 1],
    ['autopilot', 'list', 6900, 2000, 1],
    ['autopilot', 'founding', 4900, 2000, 1],
  ] as const)(
    'resolves %s/%s to the immutable complete write snapshot',
    (tier, variant, baseCents, overageCents, included) => {
      expect(resolveTierSnapshot(tier, variant)).toEqual({
        tier,
        variant,
        baseCents,
        overageCents,
        included,
      });
      expect(getTierConfig(tier)).toBe(TIER_CONFIG[tier]);
      expect(TIER_CONFIG[tier].multiLocAllowed).toBe(true);
    },
  );

  it('fails closed for unknown tier and variant inputs', () => {
    expect(() => resolveTierSnapshot('enterprise' as 'copilot', 'list')).toThrow(
      /Unknown WS8 subscription tier/,
    );
    expect(() => resolveTierSnapshot('copilot', 'discounted' as 'list')).toThrow(
      /Unknown price variant/,
    );
  });
});
