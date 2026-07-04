// Display-price derivation for the public pricing page. The billing facts live
// in TIER_CONFIG (src/lib/accounts/tier-config.ts). Note invariant #9a:
// ACCOUNTS are grandfathered on their stored snapshot — this page only
// displays the CURRENT config for new signups. The annual marketing discount
// is a display fact owned here.
import { TIER_CONFIG } from '@/lib/accounts/tier-config';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';

export const ANNUAL_DISCOUNT = 0.2;

export function monthlyPriceUsd(tier: SubscriptionTierValue): number {
  return TIER_CONFIG[tier].baseCents / 100;
}

export function annualPriceUsd(tier: SubscriptionTierValue): number {
  return Math.floor(monthlyPriceUsd(tier) * (1 - ANNUAL_DISCOUNT));
}
