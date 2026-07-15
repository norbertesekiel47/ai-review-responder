import { describe, expect, it } from 'vitest';
import { buildPlanPresentation } from '@/lib/payments/plan-presentation';

describe('pricing server view model', () => {
  it('locks list snapshots and one included location', () => {
    const view = buildPlanPresentation({
      priceVariant: 'list',
      autopilotPurchasable: true,
      trialEnabled: false,
    });

    expect(view.prices).toEqual({
      copilot: {
        basePriceCents: 2900,
        listBasePriceCents: 2900,
        locationsOveragePriceCents: 1500,
        locationsIncluded: 1,
      },
      autopilot: {
        basePriceCents: 6900,
        listBasePriceCents: 6900,
        locationsOveragePriceCents: 2000,
        locationsIncluded: 1,
      },
    });
  });

  it('changes only base cents for founding-for-life pricing', () => {
    const view = buildPlanPresentation({
      priceVariant: 'founding',
      autopilotPurchasable: false,
      trialEnabled: true,
    });

    expect(view.prices.copilot.basePriceCents).toBe(1900);
    expect(view.prices.autopilot.basePriceCents).toBe(4900);
    expect(view.prices.copilot.locationsOveragePriceCents).toBe(1500);
    expect(view.prices.autopilot.locationsOveragePriceCents).toBe(2000);
    expect(view.purchasable).toEqual({ copilot: true, autopilot: false });
    expect(view.priceVariant).toBe('founding');
    expect(view.trialEnabled).toBe(true);
  });
});
