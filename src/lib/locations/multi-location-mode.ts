import { lookupTierConfig } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

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
  if (
    subscriptionStatus !== SubscriptionStatus.ACTIVE
    && subscriptionStatus !== SubscriptionStatus.TRIALING
  ) {
    return false;
  }
  return lookupTierConfig(subscriptionTier)?.multiLocAllowed === true;
}
