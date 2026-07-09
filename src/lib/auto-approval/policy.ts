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
  }
}

/** Platform default when the effective policy's daily_auto_post_cap is NULL (spec §2.3). */
export const DEFAULT_DAILY_AUTO_POST_CAP = 10;

// Column default from migration 074 — the window applied when no policy row
// exists. Not exported until a settings/UI consumer lands (fallow gate);
// re-export then rather than duplicating the literal.
const DEFAULT_VETO_WINDOW_MINUTES = 15;

/** The enforced cap for a policy — stored value or the platform default. */
export function resolveDailyCap(policy: Pick<EffectiveAutoApprovalPolicy, 'dailyAutoPostCap'>): number {
  return policy.dailyAutoPostCap ?? DEFAULT_DAILY_AUTO_POST_CAP;
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
