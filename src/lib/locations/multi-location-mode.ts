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

/**
 * Which "locked" reason to surface when add-location is NOT available (i.e.
 * canAddLocationForAccount returned false). One tested owner for the copy
 * decision, so the page never re-derives entitlement from a raw status compare:
 *   - 'upgrade'  — the account IS entitled (full access) but its tier has no
 *                  multi-location allowance (Basic). Show the upgrade CTA.
 *   - 'inactive' — the subscription does not grant full access. Show the
 *                  "subscription must be active" CTA.
 * A trialing account grants full access, so trialing-Basic yields 'upgrade'
 * (fixes STATUS-1.1). Only meaningful in the locked branch.
 */
export function lockedAddLocationReason(
  subscriptionTier: string,
  subscriptionStatus: string,
): 'upgrade' | 'inactive' {
  if (
    subscriptionGrantsFullAccess(subscriptionStatus)
    && lookupTierConfig(subscriptionTier)?.multiLocAllowed !== true
  ) {
    return 'upgrade';
  }
  return 'inactive';
}
