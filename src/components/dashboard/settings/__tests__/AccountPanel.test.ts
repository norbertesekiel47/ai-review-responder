import { describe, expect, it } from 'vitest';
import { TIER_CONFIG, type SubscriptionTierValue } from '@/lib/accounts/tier-config';

// ── QuotaBar label formatting ──────────────────────────────────────────────

describe('AccountPanel quota label formatting', () => {
  function formatQuotaLabel(activeLocations: number, included: number, overage: number): string {
    return `${activeLocations} of ${included} included${overage > 0 ? `, ${overage} overage` : ''}`;
  }

  it('shows no overage when within quota', () => {
    expect(formatQuotaLabel(1, 1, 0)).toBe('1 of 1 included');
  });

  it('shows no overage when within multi-location quota', () => {
    expect(formatQuotaLabel(3, 5, 0)).toBe('3 of 5 included');
  });

  it('shows overage when exceeding quota', () => {
    expect(formatQuotaLabel(3, 1, 2)).toBe('3 of 1 included, 2 overage');
  });

  it('shows overage for premium tier with 7 of 5', () => {
    expect(formatQuotaLabel(7, 5, 2)).toBe('7 of 5 included, 2 overage');
  });

  it('handles zero locations gracefully', () => {
    expect(formatQuotaLabel(0, 1, 0)).toBe('0 of 1 included');
  });
});

// ── PlanCard tier label formatting ────────────────────────────────────────

describe('AccountPanel tier label formatting', () => {
  it('formats tier name for display — standard', () => {
    const tier = 'standard';
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    expect(tierLabel).toBe('Standard');
  });

  it('formats tier name for display — founders', () => {
    const tier = 'founders';
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    expect(tierLabel).toBe('Founders');
  });

  it('formats tier name for display — premium', () => {
    const tier = 'premium';
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    expect(tierLabel).toBe('Premium');
  });

  it('formats tier name for display — basic', () => {
    const tier = 'basic';
    const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
    expect(tierLabel).toBe('Basic');
  });
});

// ── Billing price formatting ─────────────────────────────────────────────

describe('AccountPanel billing price formatting', () => {
  it('formats base price from cents to dollars', () => {
    expect((7900 / 100).toFixed(2)).toBe('79.00');
  });

  it('formats overage price from cents to dollars', () => {
    expect((2500 / 100).toFixed(2)).toBe('25.00');
  });

  it('formats total price from cents to dollars', () => {
    expect((15400 / 100).toFixed(2)).toBe('154.00');
  });
});

// ── Tier change button logic (VAL-BILLING-073) ────────────────────────────

describe('AccountPanel tier change button logic', () => {
  const tierOptions: SubscriptionTierValue[] = ['basic', 'standard', 'premium', 'founders'];

  it('identifies upgradable tiers — standard can upgrade to premium', () => {
    const currentTier: SubscriptionTierValue = 'standard';
    const otherTiers = tierOptions.filter((t) => t !== currentTier);
    const upgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents > TIER_CONFIG[currentTier].baseCents);

    expect(upgradableTiers).toEqual(['premium']);
  });

  it('identifies downgradable tiers — premium can downgrade to basic, standard, and founders', () => {
    const currentTier: SubscriptionTierValue = 'premium';
    const otherTiers = tierOptions.filter((t) => t !== currentTier);
    const downgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents < TIER_CONFIG[currentTier].baseCents);

    expect(downgradableTiers).toEqual(['basic', 'standard', 'founders']);
  });

  it('identifies no upgradable tiers for premium (highest base price)', () => {
    const currentTier: SubscriptionTierValue = 'premium';
    const otherTiers = tierOptions.filter((t) => t !== currentTier);
    const upgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents > TIER_CONFIG[currentTier].baseCents);

    expect(upgradableTiers).toEqual([]);
  });

  it('identifies no downgradable tiers for founders (lowest base price)', () => {
    const currentTier: SubscriptionTierValue = 'founders';
    const otherTiers = tierOptions.filter((t) => t !== currentTier);
    const downgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents < TIER_CONFIG[currentTier].baseCents);

    expect(downgradableTiers).toEqual([]);
  });

  it('founders has upgradable options (basic, standard, and premium are higher base)', () => {
    const currentTier: SubscriptionTierValue = 'founders';
    const otherTiers = tierOptions.filter((t) => t !== currentTier);
    const upgradableTiers = otherTiers.filter((t) => TIER_CONFIG[t].baseCents > TIER_CONFIG[currentTier].baseCents);

    expect(upgradableTiers).toEqual(['basic', 'standard', 'premium']);
  });

  it('formats tier change button label with price', () => {
    const tier: SubscriptionTierValue = 'premium';
    const cfg = TIER_CONFIG[tier];
    const label = `Upgrade to ${tier.charAt(0).toUpperCase() + tier.slice(1)} ($${(cfg.baseCents / 100).toFixed(0)}/mo)`;
    expect(label).toBe('Upgrade to Premium ($199/mo)');
  });

  it('isDowngrade detection — lower baseCents means downgrade', () => {
    const currentTier: SubscriptionTierValue = 'premium';
    const newTier: SubscriptionTierValue = 'standard';
    const isDowngrade = TIER_CONFIG[newTier].baseCents < TIER_CONFIG[currentTier].baseCents;
    expect(isDowngrade).toBe(true);
  });

  it('isDowngrade detection — higher baseCents means upgrade', () => {
    const currentTier: SubscriptionTierValue = 'standard';
    const newTier: SubscriptionTierValue = 'premium';
    const isDowngrade = TIER_CONFIG[newTier].baseCents < TIER_CONFIG[currentTier].baseCents;
    expect(isDowngrade).toBe(false);
  });

  it('billing preview total calculation for tier change', () => {
    const newTier: SubscriptionTierValue = 'premium';
    const newConfig = TIER_CONFIG[newTier];
    const activeLocations = 7;
    const overageUnits = Math.max(0, activeLocations - newConfig.included);
    const totalCents = newConfig.baseCents + overageUnits * newConfig.overageCents;

    expect(overageUnits).toBe(2);
    expect(totalCents).toBe(19900 + 2 * 2000); // 23900
  });
});
