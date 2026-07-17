import {
  SubscriptionTier,
  resolveTierSnapshot,
  type PriceVariant,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';

const WS8_PLAN_ORDER = [
  SubscriptionTier.COPILOT,
  SubscriptionTier.AUTOPILOT,
] as const satisfies readonly SubscriptionTierValue[];

export interface PlanPriceView {
  basePriceCents: number;
  listBasePriceCents: number;
  locationsOveragePriceCents: number;
  locationsIncluded: number;
}

export type PlanPricesView = Record<SubscriptionTierValue, PlanPriceView>;
export type PlanPurchasabilityView = Record<SubscriptionTierValue, boolean>;

export interface PlanPresentationViewModel {
  purchasable: PlanPurchasabilityView;
  prices: PlanPricesView;
  priceVariant: PriceVariant;
  trialEnabled: boolean;
}

function planPricesForVariant(variant: PriceVariant): PlanPricesView {
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
