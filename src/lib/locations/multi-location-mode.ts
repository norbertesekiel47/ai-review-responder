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
 * The whole add-location decision for the Locations settings page, in one tested
 * place so the page never re-derives entitlement from a raw status compare:
 *   - 'enabled'  — the account may add a location now.
 *   - 'upgrade'  — entitled (full access) but on a tier with no multi-location
 *                  allowance (Basic). Show the upgrade CTA.
 *   - 'inactive' — the subscription does not grant full access. Show the
 *                  "subscription must be active" CTA.
 * Trialing grants full access, so a trialing-Basic owner resolves to 'upgrade'
 * (fixes STATUS-1.1), not 'inactive'. Total over its inputs — no caller
 * precondition to remember.
 */
export function resolveAddLocationState(
  featureEnabled: boolean,
  subscriptionTier: string,
  subscriptionStatus: string,
): 'enabled' | 'upgrade' | 'inactive' {
  if (canAddLocationForAccount(featureEnabled, subscriptionTier, subscriptionStatus)) {
    return 'enabled';
  }
  if (
    subscriptionGrantsFullAccess(subscriptionStatus)
    && lookupTierConfig(subscriptionTier)?.multiLocAllowed !== true
  ) {
    return 'upgrade';
  }
  return 'inactive';
}
