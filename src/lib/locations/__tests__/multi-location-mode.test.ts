import { describe, expect, it } from 'vitest';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import {
  canAddLocationForAccount,
  resolveAddLocationState,
  shouldShowLocationsSettings,
  shouldUseMultiLocationSettings,
} from '../multi-location-mode';

describe('shouldUseMultiLocationSettings', () => {
  it('keeps single-location settings when the feature flag is off', () => {
    expect(shouldUseMultiLocationSettings(false, 3)).toBe(false);
  });

  it('keeps single-location mode for accounts with one active location', () => {
    expect(shouldUseMultiLocationSettings(true, 1)).toBe(false);
  });

  it('uses multi-location mode once an account has multiple active locations', () => {
    expect(shouldUseMultiLocationSettings(true, 2)).toBe(true);
  });
});

describe('shouldShowLocationsSettings', () => {
  it('hides locations settings when the feature flag is off', () => {
    expect(shouldShowLocationsSettings(false)).toBe(false);
  });

  it('shows locations settings whenever the feature flag is on', () => {
    expect(shouldShowLocationsSettings(true)).toBe(true);
  });
});

describe('canAddLocationForAccount', () => {
  it.each([
    SubscriptionTier.FOUNDERS,
    SubscriptionTier.STANDARD,
    SubscriptionTier.PREMIUM,
  ] as const)(
    'allows active %s accounts when the feature flag is on',
    (tier) => {
      expect(
        canAddLocationForAccount(true, tier, SubscriptionStatus.ACTIVE),
      ).toBe(true);
    },
  );

  it('does not allow Basic even when active', () => {
    expect(
      canAddLocationForAccount(
        true,
        SubscriptionTier.BASIC,
        SubscriptionStatus.ACTIVE,
      ),
    ).toBe(false);
  });

  it.each([
    SubscriptionStatus.PENDING_PAYMENT,
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELLED,
    'unknown',
  ] as const)(
    'does not allow standard accounts when subscription status is %s',
    (status) => {
      expect(
        canAddLocationForAccount(true, SubscriptionTier.STANDARD, status),
      ).toBe(false);
    },
  );

  it('does not allow eligible tiers when the feature flag is off', () => {
    expect(
      canAddLocationForAccount(
        false,
        SubscriptionTier.STANDARD,
        SubscriptionStatus.ACTIVE,
      ),
    ).toBe(false);
  });

  it('does not allow unknown tiers', () => {
    expect(
      canAddLocationForAccount(true, 'enterprise', SubscriptionStatus.ACTIVE),
    ).toBe(false);
  });
});

describe('resolveAddLocationState', () => {
  it.each([
    [SubscriptionTier.FOUNDERS, SubscriptionStatus.ACTIVE],
    [SubscriptionTier.STANDARD, SubscriptionStatus.ACTIVE],
    [SubscriptionTier.STANDARD, SubscriptionStatus.TRIALING],
  ] as const)('returns "enabled" for an entitled multi-location tier (%s, %s)', (tier, status) => {
    expect(resolveAddLocationState(true, tier, status)).toBe('enabled');
  });

  // The STATUS-1.1 bug: a trialing Basic owner is entitled (full access) but on a
  // tier with no multi-location allowance → must resolve to 'upgrade', not 'inactive'.
  it('returns "upgrade" for a trialing Basic owner (entitled, no multi-loc tier)', () => {
    expect(resolveAddLocationState(true, SubscriptionTier.BASIC, SubscriptionStatus.TRIALING)).toBe('upgrade');
  });

  it('returns "upgrade" for an active Basic owner', () => {
    expect(resolveAddLocationState(true, SubscriptionTier.BASIC, SubscriptionStatus.ACTIVE)).toBe('upgrade');
  });

  it.each([
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELLED,
    SubscriptionStatus.PENDING_PAYMENT,
  ] as const)('returns "inactive" when the subscription does not grant access (%s)', (status) => {
    expect(resolveAddLocationState(true, SubscriptionTier.BASIC, status)).toBe('inactive');
  });
});
