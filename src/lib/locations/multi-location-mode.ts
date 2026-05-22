import { lookupTierConfig } from '@/lib/accounts/tier-config';

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
  if (subscriptionStatus !== 'active') return false;
  return lookupTierConfig(subscriptionTier)?.multiLocAllowed === true;
}
