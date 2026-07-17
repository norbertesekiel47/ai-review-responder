import {
  isSubscriptionTier,
  lookupTierConfig,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';

export function shouldUseMultiLocationSettings(
  featureEnabled: boolean,
  activeLocationCount: number,
): boolean {
  return featureEnabled && activeLocationCount > 1;
}

export function shouldShowLocationsSettings(featureEnabled: boolean): boolean {
  return featureEnabled;
}

export function canAddLocationForAccount(
  featureEnabled: boolean,
  subscriptionTier: string,
  subscriptionStatus: string,
): boolean {
  if (!featureEnabled) return false;
  if (!subscriptionGrantsFullAccess(subscriptionStatus)) return false;
  return lookupTierConfig(subscriptionTier)?.multiLocAllowed === true;
}

/**
 * The whole add-location decision for the Locations settings page, in one tested
 * place so the page never re-derives entitlement from a raw status compare:
 *   - 'enabled'  — the account may add a location now.
 *   - 'inactive' — the subscription does not grant full access. Show the
 *                  "subscription must be active" CTA.
 * Trialing grants full access. Total over its inputs — no caller precondition
 * to remember.
 */
export function resolveAddLocationState(
  featureEnabled: boolean,
  subscriptionTier: SubscriptionTierValue,
  subscriptionStatus: string,
): 'enabled' | 'inactive' {
  if (!isSubscriptionTier(subscriptionTier)) {
    throw new Error(`invalid_ws8_subscription_tier:${String(subscriptionTier)}`);
  }
  if (canAddLocationForAccount(featureEnabled, subscriptionTier, subscriptionStatus)) {
    return 'enabled';
  }
  return 'inactive';
}
