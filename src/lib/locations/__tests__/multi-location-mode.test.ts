import { describe, expect, it } from 'vitest';
import { SubscriptionTier, type SubscriptionTierValue } from '@/lib/accounts/tier-config';
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
    SubscriptionTier.COPILOT,
    SubscriptionTier.AUTOPILOT,
  ] as const)(
    'allows active %s accounts when the feature flag is on',
    (tier) => {
      expect(
        canAddLocationForAccount(true, tier, SubscriptionStatus.ACTIVE),
      ).toBe(true);
    },
  );

  it.each([
    SubscriptionStatus.PENDING_PAYMENT,
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELLED,
    'unknown',
  ] as const)(
    'does not allow Copilot accounts when subscription status is %s',
    (status) => {
      expect(
        canAddLocationForAccount(true, SubscriptionTier.COPILOT, status),
      ).toBe(false);
    },
  );

  it('does not allow eligible tiers when the feature flag is off', () => {
    expect(
      canAddLocationForAccount(
        false,
        SubscriptionTier.COPILOT,
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
    [SubscriptionTier.COPILOT, SubscriptionStatus.ACTIVE],
    [SubscriptionTier.AUTOPILOT, SubscriptionStatus.ACTIVE],
    [SubscriptionTier.COPILOT, SubscriptionStatus.TRIALING],
  ] as const)('returns "enabled" for an entitled multi-location tier (%s, %s)', (tier, status) => {
    expect(resolveAddLocationState(true, tier, status)).toBe('enabled');
  });

  it('fails closed for an entitled account with an unsupported tier', () => {
    const unsupportedTier = 'retired_tier' as unknown as SubscriptionTierValue;
    expect(() => resolveAddLocationState(
      true,
      unsupportedTier,
      SubscriptionStatus.TRIALING,
    )).toThrow('invalid_ws8_subscription_tier:retired_tier');
  });

  it.each([
    SubscriptionStatus.PAST_DUE,
    SubscriptionStatus.CANCELLED,
    SubscriptionStatus.PENDING_PAYMENT,
  ] as const)('returns "inactive" when the subscription does not grant access (%s)', (status) => {
    expect(resolveAddLocationState(true, SubscriptionTier.COPILOT, status)).toBe('inactive');
  });
});
