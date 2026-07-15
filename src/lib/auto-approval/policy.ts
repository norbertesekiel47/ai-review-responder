import type {
  AutoApprovalThreshold,
  EffectiveAutoApprovalPolicy,
  PolicyExposureClassification,
  PolicyRowState,
} from './types';

export type PolicyExposure = Pick<
  EffectiveAutoApprovalPolicy,
  'threshold' | 'vetoWindowMinutes' | 'dailyAutoPostCap'
>;

export function exposureRank(threshold: AutoApprovalThreshold | null): number {
  switch (threshold) {
    case null:
      return 0;
    case 5:
      return 1;
    case 4:
      return 2;
  }
}

/** Platform default when the effective policy's daily_auto_post_cap is NULL (spec §2.3). */
export const DEFAULT_DAILY_AUTO_POST_CAP = 10;

/** Column default from migration 074 — the window applied when no policy row exists. */
export const DEFAULT_VETO_WINDOW_MINUTES = 15;

/** The enforced cap for a policy — stored value or the platform default. */
export function resolveDailyCap(policy: Pick<EffectiveAutoApprovalPolicy, 'dailyAutoPostCap'>): number {
  return policy.dailyAutoPostCap ?? DEFAULT_DAILY_AUTO_POST_CAP;
}

export function isThresholdExpansion(
  before: AutoApprovalThreshold | null,
  after: AutoApprovalThreshold | null,
): boolean {
  return classifyThresholdExposure(before, after) === 'expansion';
}

export function classifyThresholdExposure(
  before: AutoApprovalThreshold | null,
  after: AutoApprovalThreshold | null,
): PolicyExposureClassification {
  const delta = exposureRank(after) - exposureRank(before);
  if (delta > 0) return 'expansion';
  if (delta < 0) return 'contraction';
  return 'no_change';
}

export function classifyVetoWindowExposure(
  before: PolicyExposure['vetoWindowMinutes'],
  after: PolicyExposure['vetoWindowMinutes'],
): PolicyExposureClassification {
  if (after < before) return 'expansion';
  if (after > before) return 'contraction';
  return 'no_change';
}

export function classifyDailyCapExposure(
  before: PolicyExposure['dailyAutoPostCap'],
  after: PolicyExposure['dailyAutoPostCap'],
): PolicyExposureClassification {
  if (before === after) return 'no_change';
  // NULL means the uncapped-by-owner platform default. Removing a finite cap
  // is therefore always an expansion; adding one is always a contraction,
  // regardless of the platform default's current numeric value.
  if (after === null) return 'expansion';
  if (before === null) return 'contraction';
  return after > before ? 'expansion' : 'contraction';
}

/**
 * The single WS8 owner for trust-dial exposure classification. Any broader
 * dimension wins over simultaneous contractions in another dimension (the
 * important case is creating/deleting an inherited location override).
 *
 * A complete disable is intentionally special: once the resulting threshold
 * is manual, resetting otherwise-stored dials cannot trap an owner behind an
 * Autopilot gate. Dial-only edits on an already-manual row are not complete
 * disables and continue to be classified normally.
 */
export function classifyPolicyExposure(
  before: PolicyExposure,
  after: PolicyExposure,
  options: { completeDisable?: boolean } = {},
): PolicyExposureClassification {
  if (options.completeDisable && after.threshold === null) {
    return before.threshold === null ? 'no_change' : 'contraction';
  }

  const dimensions = [
    classifyThresholdExposure(before.threshold, after.threshold),
    classifyVetoWindowExposure(before.vetoWindowMinutes, after.vetoWindowMinutes),
    classifyDailyCapExposure(before.dailyAutoPostCap, after.dailyAutoPostCap),
  ];
  if (dimensions.includes('expansion')) return 'expansion';
  if (dimensions.includes('contraction')) return 'contraction';
  return 'no_change';
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
  const winner = locationOverride ?? accountDefault;
  if (!winner) {
    return {
      source: 'none',
      threshold: null,
      policyId: null,
      vetoWindowMinutes: DEFAULT_VETO_WINDOW_MINUTES,
      dailyAutoPostCap: null,
      suspended: false,
    };
  }
  // The account-level suspension (governor kill switch, spec §2.4) applies even
  // when a location override wins the threshold resolution.
  const suspended = Boolean(accountDefault?.suspendedAt) || Boolean(winner.suspendedAt);
  return {
    source: locationOverride ? 'location_override' : 'account_default',
    threshold: winner.autoApproveMinStar,
    policyId: winner.id,
    vetoWindowMinutes: winner.vetoWindowMinutes,
    dailyAutoPostCap: winner.dailyAutoPostCap,
    suspended,
  };
}
