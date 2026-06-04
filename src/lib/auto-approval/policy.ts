import type {
  AutoApprovalThreshold,
  EffectiveAutoApprovalPolicy,
  PolicyRowState,
} from './types';

export function exposureRank(threshold: AutoApprovalThreshold | null): number {
  switch (threshold) {
    case null:
      return 0;
    case 5:
      return 1;
    case 4:
      return 2;
    case 3:
      return 3;
    case 2:
      return 4;
    case 1:
      return 5;
  }
}

export function isThresholdExpansion(
  before: AutoApprovalThreshold | null,
  after: AutoApprovalThreshold | null,
): boolean {
  return exposureRank(after) > exposureRank(before);
}

export function starMeetsThreshold(
  starRating: number | null,
  threshold: AutoApprovalThreshold | null,
): boolean {
  if (starRating === null || threshold === null) return false;
  return starRating >= threshold;
}

export function resolveEffectivePolicy(
  accountDefault: PolicyRowState | null,
  locationOverride: PolicyRowState | null,
): EffectiveAutoApprovalPolicy {
  if (locationOverride) {
    return {
      source: 'location_override',
      threshold: locationOverride.autoApproveMinStar,
      policyId: locationOverride.id,
    };
  }

  if (accountDefault) {
    return {
      source: 'account_default',
      threshold: accountDefault.autoApproveMinStar,
      policyId: accountDefault.id,
    };
  }

  return {
    source: 'none',
    threshold: null,
    policyId: null,
  };
}
