import { SUBSCRIPTION_TIER_ORDER, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
import type { PlanPresentationViewModel } from '@/lib/payments/plan-presentation';

export interface OnboardingPlan {
  tier: SubscriptionTierValue;
  name: string;
  price: string;
  listPrice: string;
  overagePrice: string;
  badge: string;
  badgeTone: 'sage' | 'peach';
  description: string;
  highlight: boolean;
  features: readonly string[];
  purchasable: boolean;
  unavailableReason: string | null;
}

type PlanCopy = Omit<
  OnboardingPlan,
  'price' | 'listPrice' | 'overagePrice' | 'purchasable' | 'unavailableReason'
>;

const PLAN_COPY: Record<SubscriptionTierValue, PlanCopy> = {
  copilot: {
    tier: 'copilot',
    name: 'Copilot',
    badge: 'Owner approved',
    badgeTone: 'sage',
    description: 'The agent team drafts every public reply and waits for your approval.',
    highlight: false,
    features: [
      'Reply drafts in your business voice',
      'Guardian holds negative and flagged reviews',
      'Insights files your weekly brief',
      'Every public action requires owner approval',
      'One included location',
    ],
  },
  autopilot: {
    tier: 'autopilot',
    name: 'Autopilot',
    badge: 'Policy controlled',
    badgeTone: 'peach',
    description: 'The same team may act inside your rules after every safety gate passes.',
    highlight: true,
    features: [
      'Everything in Copilot',
      'Only 4–5★ unflagged replies may auto-post',
      'Owner-set policy and veto window',
      'Moderation, judge, and governor safeguards',
      'Negative reviews are never auto-posted',
    ],
  },
};

export function formatMonthlyPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function getOnboardingPlans(
  viewModel: PlanPresentationViewModel,
): readonly OnboardingPlan[] {
  return SUBSCRIPTION_TIER_ORDER.map((tier) => {
    const price = viewModel.prices[tier];
    return {
      ...PLAN_COPY[tier],
      price: formatMonthlyPrice(price.basePriceCents),
      listPrice: formatMonthlyPrice(price.listBasePriceCents),
      overagePrice: formatMonthlyPrice(price.locationsOveragePriceCents),
      purchasable: viewModel.purchasable[tier],
      unavailableReason: viewModel.purchasable[tier]
        ? null
        : 'Autopilot is temporarily unavailable. Choose Copilot to continue.',
    };
  });
}
