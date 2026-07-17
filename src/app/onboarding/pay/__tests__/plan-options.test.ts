import { describe, expect, it } from 'vitest';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';
import { formatMonthlyPrice, getOnboardingPlans } from '../plan-options';

describe('onboarding plan options', () => {
  it('builds exactly two plans from the supplied list-price view model', () => {
    const plans = getOnboardingPlans(buildPlanPresentation({
      priceVariant: 'list',
      autopilotPurchasable: true,
      trialEnabled: false,
    }));

    expect(plans.map((plan) => plan.tier)).toEqual(['copilot', 'autopilot']);
    expect(plans.map((plan) => plan.price)).toEqual(['$29', '$69']);
    expect(plans.map((plan) => plan.overagePrice)).toEqual(['$15', '$20']);
  });

  it('uses supplied founding prices without deriving list amounts in the client', () => {
    const plans = getOnboardingPlans(buildPlanPresentation({
      priceVariant: 'founding',
      autopilotPurchasable: false,
      trialEnabled: true,
    }));

    expect(plans.map((plan) => plan.price)).toEqual(['$19', '$49']);
    expect(plans.map((plan) => plan.listPrice)).toEqual(['$29', '$69']);
    expect(plans[1]).toMatchObject({ purchasable: false });
    expect(plans[1]?.unavailableReason).toMatch(/temporarily unavailable/i);
  });

  it('formats whole-dollar and decimal prices', () => {
    expect(formatMonthlyPrice(6900)).toBe('$69');
    expect(formatMonthlyPrice(6950)).toBe('$69.50');
  });
});
