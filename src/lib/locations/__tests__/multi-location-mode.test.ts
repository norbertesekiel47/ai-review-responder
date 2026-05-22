import { describe, expect, it } from 'vitest';
import {
  canAddLocationForAccount,
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
  it.each(['founders', 'standard', 'premium'] as const)(
    'allows active %s accounts when the feature flag is on',
    (tier) => {
      expect(canAddLocationForAccount(true, tier, 'active')).toBe(true);
    },
  );

  it('does not allow Basic even when active', () => {
    expect(canAddLocationForAccount(true, 'basic', 'active')).toBe(false);
  });

  it('does not allow eligible tiers when subscription is not active', () => {
    expect(canAddLocationForAccount(true, 'standard', 'pending_payment')).toBe(false);
  });

  it('does not allow eligible tiers when the feature flag is off', () => {
    expect(canAddLocationForAccount(false, 'standard', 'active')).toBe(false);
  });

  it('does not allow unknown tiers', () => {
    expect(canAddLocationForAccount(true, 'enterprise', 'active')).toBe(false);
  });
});
