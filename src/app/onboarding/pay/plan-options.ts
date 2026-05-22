import {
  SubscriptionTier,
  TIER_CONFIG,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';

export interface OnboardingPlan {
  tier: SubscriptionTierValue;
  name: string;
  price: string;
  badge: string;
  badgeColor: string;
  badgeText: string;
  description: string;
  highlight: boolean;
  features: readonly string[];
  cta: string;
}

export const ONBOARDING_PLAN_ORDER = [
  SubscriptionTier.FOUNDERS,
  SubscriptionTier.BASIC,
  SubscriptionTier.STANDARD,
  SubscriptionTier.PREMIUM,
] satisfies readonly SubscriptionTierValue[];

type PlanCopy = Omit<OnboardingPlan, 'tier' | 'price'>;

const PLAN_COPY: Record<SubscriptionTierValue, PlanCopy> = {
  founders: {
    name: 'Founding Member',
    badge: 'Limited — 10 slots',
    badgeColor: '#F2C3B9',
    badgeText: '#2a2a2a',
    description: 'Rate locked for life.',
    highlight: true,
    cta: 'Claim founding rate',
    features: [
      'Google review monitoring (hourly)',
      'AI-powered personalized responses',
      'One-tap email approval',
      'Weekly review intelligence brief',
      'ROI dashboard',
      'Dedicated onboarding call',
      'Rate locked for life',
    ],
  },
  basic: {
    name: 'Basic',
    badge: 'Single location',
    badgeColor: '#F0EEEA',
    badgeText: '#2a2a2a',
    description: 'Simple review response coverage for one location.',
    highlight: false,
    cta: 'Choose Basic',
    features: [
      'One included location',
      'Google review monitoring',
      'AI-powered personalized responses',
      'One-tap email approval',
      'Weekly review intelligence brief',
    ],
  },
  standard: {
    name: 'Standard',
    badge: 'Most popular',
    badgeColor: '#97B3AE',
    badgeText: '#ffffff',
    description: 'Everything you need to manage reviews across locations.',
    highlight: false,
    cta: 'Choose Standard',
    features: [
      'Everything in Basic',
      'Multi-location add-ons available',
      'Priority support',
      'Advanced analytics',
      'Custom response style guide',
    ],
  },
  premium: {
    name: 'Premium',
    badge: 'High volume',
    badgeColor: '#2a2a2a',
    badgeText: '#ffffff',
    description: 'For high-volume teams with more included location coverage.',
    highlight: false,
    cta: 'Choose Premium',
    features: [
      'Everything in Standard',
      'Five included locations',
      'Lower per-location add-on rate',
      'Up to 50 historical reviews backfilled on connect',
      'Priority support',
    ],
  },
};

export function formatMonthlyPrice(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

export function getOnboardingPlans(): readonly OnboardingPlan[] {
  return ONBOARDING_PLAN_ORDER.map((tier) => ({
    tier,
    price: formatMonthlyPrice(TIER_CONFIG[tier].baseCents),
    ...PLAN_COPY[tier],
  }));
}
