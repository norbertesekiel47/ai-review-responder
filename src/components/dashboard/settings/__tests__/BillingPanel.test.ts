import { describe, expect, it } from 'vitest';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';

describe('BillingPanel server plan presentation', () => {
  it('contains only Copilot and Autopilot target prices for a list account', () => {
    const presentation = buildPlanPresentation({
      priceVariant: 'list',
      autopilotPurchasable: true,
      trialEnabled: false,
    });

    expect(Object.keys(presentation.prices)).toEqual(['copilot', 'autopilot']);
    expect(presentation.prices.copilot.basePriceCents).toBe(2900);
    expect(presentation.prices.autopilot.basePriceCents).toBe(6900);
  });

  it('keeps founding target amounts across the tier boundary', () => {
    const presentation = buildPlanPresentation({
      priceVariant: 'founding',
      autopilotPurchasable: true,
      trialEnabled: false,
    });

    expect(presentation.prices.copilot.basePriceCents).toBe(1900);
    expect(presentation.prices.autopilot.basePriceCents).toBe(4900);
    expect(presentation.priceVariant).toBe('founding');
  });
});
