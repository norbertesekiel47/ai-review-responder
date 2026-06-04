import { describe, expect, it } from 'vitest';
import type { PolicyRowState } from '../types';
import {
  exposureRank,
  isThresholdExpansion,
  resolveEffectivePolicy,
  starMeetsThreshold,
} from '../policy';

function row(overrides: Partial<PolicyRowState>): PolicyRowState {
  return {
    id: 'policy-1',
    accountId: 'account-1',
    locationId: null,
    autoApproveMinStar: null,
    ...overrides,
  };
}

describe('auto-approval policy helpers', () => {
  it('orders exposure from manual through all rated reviews', () => {
    expect(exposureRank(null)).toBe(0);
    expect(exposureRank(5)).toBe(1);
    expect(exposureRank(4)).toBe(2);
    expect(exposureRank(3)).toBe(3);
    expect(exposureRank(2)).toBe(4);
    expect(exposureRank(1)).toBe(5);
  });

  it('detects expansions and contractions by exposure rank', () => {
    expect(isThresholdExpansion(null, 5)).toBe(true);
    expect(isThresholdExpansion(5, 4)).toBe(true);
    expect(isThresholdExpansion(4, 4)).toBe(false);
    expect(isThresholdExpansion(3, 5)).toBe(false);
    expect(isThresholdExpansion(1, null)).toBe(false);
  });

  it('checks star ratings against nullable thresholds fail-closed', () => {
    expect(starMeetsThreshold(null, 5)).toBe(false);
    expect(starMeetsThreshold(5, null)).toBe(false);
    expect(starMeetsThreshold(4, 5)).toBe(false);
    expect(starMeetsThreshold(4, 4)).toBe(true);
    expect(starMeetsThreshold(5, 4)).toBe(true);
    expect(starMeetsThreshold(1, 1)).toBe(true);
  });

  it('resolves no rows to no effective policy', () => {
    expect(resolveEffectivePolicy(null, null)).toEqual({
      source: 'none',
      threshold: null,
      policyId: null,
    });
  });

  it('uses account default when no location override row exists', () => {
    expect(resolveEffectivePolicy(row({ id: 'account-policy', autoApproveMinStar: 4 }), null)).toEqual({
      source: 'account_default',
      threshold: 4,
      policyId: 'account-policy',
    });
  });

  it('uses location override including explicit manual null', () => {
    expect(
      resolveEffectivePolicy(
        row({ id: 'account-policy', autoApproveMinStar: 4 }),
        row({ id: 'location-policy', locationId: 'location-1', autoApproveMinStar: null }),
      ),
    ).toEqual({
      source: 'location_override',
      threshold: null,
      policyId: 'location-policy',
    });
  });
});
