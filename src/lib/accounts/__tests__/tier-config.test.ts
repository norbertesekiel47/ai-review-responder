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
  tierChangeDirection,
  tierGrantsAutopilot,
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
    ['copilot', 'list', 7900, 7900, 1],
    ['copilot', 'founding', 4900, 7900, 1],
    ['autopilot', 'list', 14900, 14900, 1],
    ['autopilot', 'founding', 9900, 14900, 1],
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

describe('tierGrantsAutopilot', () => {
  it('is the single authoritative autopilot-entitlement predicate', () => {
    expect(tierGrantsAutopilot(SubscriptionTier.AUTOPILOT)).toBe(true);
    expect(tierGrantsAutopilot(SubscriptionTier.COPILOT)).toBe(false);
    expect(tierGrantsAutopilot(null)).toBe(false);
    expect(tierGrantsAutopilot(undefined)).toBe(false);
    expect(tierGrantsAutopilot('enterprise')).toBe(false);
  });
});

describe('tierChangeDirection', () => {
  it('tierChangeDirection returns up for copilot to autopilot', () => {
    expect(tierChangeDirection(SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT)).toBe('up');
  });

  it('tierChangeDirection returns down for autopilot to copilot', () => {
    expect(tierChangeDirection(SubscriptionTier.AUTOPILOT, SubscriptionTier.COPILOT)).toBe('down');
  });

  it('tierChangeDirection returns same for a tier to itself', () => {
    expect(tierChangeDirection(SubscriptionTier.COPILOT, SubscriptionTier.COPILOT)).toBe('same');
    expect(tierChangeDirection(SubscriptionTier.AUTOPILOT, SubscriptionTier.AUTOPILOT)).toBe('same');
  });

  // Today's catalogue order happens to agree with autonomy order, so every
  // other direction test also passes a price-based implementation. This one
  // pins the contract: direction comes from SUBSCRIPTION_TIER_ORDER, never a
  // price.
  it('tierChangeDirection follows autonomy order when catalogue prices are equal or reversed', () => {
    const originalCopilot = TIER_CONFIG.copilot;
    const originalAutopilot = TIER_CONFIG.autopilot;
    try {
      TIER_CONFIG.copilot = { ...originalCopilot, baseByVariant: { list: 9900, founding: 9900 } };
      TIER_CONFIG.autopilot = { ...originalAutopilot, baseByVariant: { list: 9900, founding: 9900 } };
      expect(tierChangeDirection(SubscriptionTier.AUTOPILOT, SubscriptionTier.COPILOT)).toBe('down');
      expect(tierChangeDirection(SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT)).toBe('up');

      TIER_CONFIG.copilot = { ...originalCopilot, baseByVariant: { list: 14900, founding: 9900 } };
      TIER_CONFIG.autopilot = { ...originalAutopilot, baseByVariant: { list: 7900, founding: 4900 } };
      expect(tierChangeDirection(SubscriptionTier.AUTOPILOT, SubscriptionTier.COPILOT)).toBe('down');
      expect(tierChangeDirection(SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT)).toBe('up');
    } finally {
      TIER_CONFIG.copilot = originalCopilot;
      TIER_CONFIG.autopilot = originalAutopilot;
    }
  });
});
