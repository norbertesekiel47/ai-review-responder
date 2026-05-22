import { describe, expect, it } from 'vitest';

import {
  formatMonthlyPrice,
  getOnboardingPlans,
  ONBOARDING_PLAN_ORDER,
} from '../plan-options';

describe('onboarding plan options', () => {
  it('lists all four canonical onboarding tiers in display order', () => {
    expect(ONBOARDING_PLAN_ORDER).toEqual([
      'founders',
      'basic',
      'standard',
      'premium',
    ]);

    expect(getOnboardingPlans().map((plan) => plan.tier)).toEqual([
      'founders',
      'basic',
      'standard',
      'premium',
    ]);
  });

  it('formats verified canonical monthly prices', () => {
    const byTier = Object.fromEntries(
      getOnboardingPlans().map((plan) => [plan.tier, plan.price]),
    );

    expect(byTier).toMatchObject({
      founders: '$19',
      basic: '$29',
      standard: '$79',
      premium: '$199',
    });
  });

  it('formats whole-dollar and decimal prices', () => {
    expect(formatMonthlyPrice(7900)).toBe('$79');
    expect(formatMonthlyPrice(7950)).toBe('$79.50');
  });
});
