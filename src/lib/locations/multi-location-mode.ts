import { lookupTierConfig } from '@/lib/accounts/tier-config';
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
