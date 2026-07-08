import { describe, expect, it } from 'vitest';
import type { PolicyRowState } from '../types';
import { isAutoApprovalThreshold } from '../types';
import {
  DEFAULT_DAILY_AUTO_POST_CAP,
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
    vetoWindowMinutes: 15,
    dailyAutoPostCap: null,
    suspendedAt: null,
    ...overrides,
  };
}

describe('auto-approval policy helpers', () => {
  it('accepts only positive-quadrant thresholds', () => {
    expect(isAutoApprovalThreshold(4)).toBe(true);
    expect(isAutoApprovalThreshold(5)).toBe(true);
    expect(isAutoApprovalThreshold(3)).toBe(false);
    expect(isAutoApprovalThreshold(2)).toBe(false);
    expect(isAutoApprovalThreshold(1)).toBe(false);
    expect(isAutoApprovalThreshold(null)).toBe(false);
    expect(isAutoApprovalThreshold('4')).toBe(false);
  });

  it('orders exposure from manual through the positive quadrant', () => {
    expect(exposureRank(null)).toBe(0);
    expect(exposureRank(5)).toBe(1);
    expect(exposureRank(4)).toBe(2);
  });

  it('detects expansions and contractions by exposure rank', () => {
    expect(isThresholdExpansion(null, 5)).toBe(true);
    expect(isThresholdExpansion(5, 4)).toBe(true);
    expect(isThresholdExpansion(4, 4)).toBe(false);
    expect(isThresholdExpansion(4, 5)).toBe(false);
    expect(isThresholdExpansion(4, null)).toBe(false);
  });

  it('checks star ratings against nullable thresholds fail-closed', () => {
    expect(starMeetsThreshold(null, 5)).toBe(false);
    expect(starMeetsThreshold(5, null)).toBe(false);
    expect(starMeetsThreshold(4, 5)).toBe(false);
    expect(starMeetsThreshold(3, 4)).toBe(false);
    expect(starMeetsThreshold(4, 4)).toBe(true);
    expect(starMeetsThreshold(5, 4)).toBe(true);
  });

  it('exposes the platform default daily cap for NULL policy caps', () => {
    expect(DEFAULT_DAILY_AUTO_POST_CAP).toBe(10);
  });

  it('resolves no rows to no effective policy with safe dial defaults', () => {
    expect(resolveEffectivePolicy(null, null)).toEqual({
      source: 'none',
      threshold: null,
      policyId: null,
      vetoWindowMinutes: 15,
      dailyAutoPostCap: null,
      suspended: false,
    });
  });

  it('uses account default dial fields when no location override row exists', () => {
    expect(
      resolveEffectivePolicy(
        row({
          id: 'account-policy',
          autoApproveMinStar: 4,
          vetoWindowMinutes: 30,
          dailyAutoPostCap: 5,
        }),
        null,
      ),
    ).toEqual({
      source: 'account_default',
      threshold: 4,
      policyId: 'account-policy',
      vetoWindowMinutes: 30,
      dailyAutoPostCap: 5,
      suspended: false,
    });
  });

  it('uses location override dial fields including explicit manual null', () => {
    expect(
      resolveEffectivePolicy(
        row({
          id: 'account-policy',
          autoApproveMinStar: 4,
          vetoWindowMinutes: 30,
          dailyAutoPostCap: 5,
        }),
        row({
          id: 'location-policy',
          locationId: 'location-1',
          autoApproveMinStar: null,
          vetoWindowMinutes: 15,
          dailyAutoPostCap: 20,
        }),
      ),
    ).toEqual({
      source: 'location_override',
      threshold: null,
      policyId: 'location-policy',
      vetoWindowMinutes: 15,
      dailyAutoPostCap: 20,
      suspended: false,
    });
  });

  it('suspends when the account default carries suspended_at even if an override wins', () => {
    const resolved = resolveEffectivePolicy(
      row({ id: 'account-policy', autoApproveMinStar: 4, suspendedAt: new Date('2026-07-07T00:00:00Z') }),
      row({ id: 'location-policy', locationId: 'location-1', autoApproveMinStar: 5 }),
    );
    expect(resolved.source).toBe('location_override');
    expect(resolved.suspended).toBe(true);
  });

  it('suspends when the winning override row carries suspended_at', () => {
    const resolved = resolveEffectivePolicy(
      row({ id: 'account-policy', autoApproveMinStar: 4 }),
      row({
        id: 'location-policy',
        locationId: 'location-1',
        autoApproveMinStar: 5,
        suspendedAt: new Date('2026-07-07T00:00:00Z'),
      }),
    );
    expect(resolved.suspended).toBe(true);
  });

  it('suspends on a suspended account default with no override', () => {
    const resolved = resolveEffectivePolicy(
      row({ id: 'account-policy', autoApproveMinStar: 5, suspendedAt: new Date('2026-07-07T00:00:00Z') }),
      null,
    );
    expect(resolved.source).toBe('account_default');
    expect(resolved.suspended).toBe(true);
  });

  it('does not suspend when neither row carries suspended_at', () => {
    const resolved = resolveEffectivePolicy(
      row({ id: 'account-policy', autoApproveMinStar: 4 }),
      row({ id: 'location-policy', locationId: 'location-1', autoApproveMinStar: 5 }),
    );
    expect(resolved.suspended).toBe(false);
  });
});
