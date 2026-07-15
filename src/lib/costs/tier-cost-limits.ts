import { getServerConfig } from '@/lib/config/server';
import {
  SubscriptionTier,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';

export const TIER_COST_LIMIT_ENV_VARS = [
  'DAILY_COST_LIMIT_CENTS_COPILOT',
  'DAILY_COST_LIMIT_CENTS_AUTOPILOT',
] as const;

type TierCostLimitEnvVar = (typeof TIER_COST_LIMIT_ENV_VARS)[number];

const ENV_BY_TIER: Readonly<Record<SubscriptionTierValue, TierCostLimitEnvVar>> = {
  [SubscriptionTier.COPILOT]: 'DAILY_COST_LIMIT_CENTS_COPILOT',
  [SubscriptionTier.AUTOPILOT]: 'DAILY_COST_LIMIT_CENTS_AUTOPILOT',
};

export function parseRequiredPositiveCostLimitCents(
  envName: TierCostLimitEnvVar,
  raw: string | undefined,
): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`[config] ${envName} must be a positive decimal integer`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`[config] ${envName} must be a positive decimal integer`);
  }
  return parsed;
}

function rawLimits(): Record<TierCostLimitEnvVar, string | undefined> {
  const config = getServerConfig();
  return {
    DAILY_COST_LIMIT_CENTS_COPILOT: config.DAILY_COST_LIMIT_CENTS_COPILOT,
    DAILY_COST_LIMIT_CENTS_AUTOPILOT: config.DAILY_COST_LIMIT_CENTS_AUTOPILOT,
  };
}

export function tierDailyCostLimitCents(tier: SubscriptionTierValue): number {
  const envName = ENV_BY_TIER[tier];
  if (!envName) {
    throw new Error(`[config] Unsupported subscription tier for cost limit: ${String(tier)}`);
  }
  return parseRequiredPositiveCostLimitCents(envName, rawLimits()[envName]);
}

export function assertTierDailyCostLimitsConfigured(): void {
  const limits = rawLimits();
  for (const envName of TIER_COST_LIMIT_ENV_VARS) {
    parseRequiredPositiveCostLimitCents(envName, limits[envName]);
  }
}

/** Existing global ceiling remains optional with its established fallback. */
export function optionalNonnegativeCostLimitCents(
  raw: string | undefined,
  fallback: number,
): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
