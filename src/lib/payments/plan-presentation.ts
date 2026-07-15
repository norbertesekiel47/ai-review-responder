import {
  SubscriptionTier,
  resolveTierSnapshot,
  type PriceVariant,
  type Ws8SubscriptionTier,
} from '@/lib/accounts/tier-config';

export const WS8_PLAN_ORDER = [
  SubscriptionTier.COPILOT,
  SubscriptionTier.AUTOPILOT,
] as const satisfies readonly Ws8SubscriptionTier[];

export interface PlanPriceView {
  basePriceCents: number;
  listBasePriceCents: number;
  locationsOveragePriceCents: number;
  locationsIncluded: number;
}

export type PlanPricesView = Record<Ws8SubscriptionTier, PlanPriceView>;
export type PlanPurchasabilityView = Record<Ws8SubscriptionTier, boolean>;

export interface PlanPresentationViewModel {
  purchasable: PlanPurchasabilityView;
  prices: PlanPricesView;
  priceVariant: PriceVariant;
  trialEnabled: boolean;
}

export function planPricesForVariant(variant: PriceVariant): PlanPricesView {
  return Object.fromEntries(
    WS8_PLAN_ORDER.map((tier) => {
      const snapshot = resolveTierSnapshot(tier, variant);
      const listSnapshot = resolveTierSnapshot(tier, 'list');
      return [
        tier,
        {
          basePriceCents: snapshot.baseCents,
          listBasePriceCents: listSnapshot.baseCents,
          locationsOveragePriceCents: snapshot.overageCents,
          locationsIncluded: snapshot.included,
        },
      ];
    }),
  ) as PlanPricesView;
}

export function buildPlanPresentation(input: {
  priceVariant: PriceVariant;
  autopilotPurchasable: boolean;
  trialEnabled: boolean;
}): PlanPresentationViewModel {
  return {
    purchasable: {
      copilot: true,
      autopilot: input.autopilotPurchasable,
    },
    prices: planPricesForVariant(input.priceVariant),
    priceVariant: input.priceVariant,
    trialEnabled: input.trialEnabled,
  };
}
