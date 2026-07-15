// src/lib/accounts/tier-config.ts
//
// Central SubscriptionTier type/const and tier configuration map.
// Every piece of code that references subscription tier values must use
// these — never bare subscription-tier string literals.
//
// Validation contract: VAL-BILLING-028, VAL-BILLING-042.


// ── Const object (enum-like) ──────────────────────────────────────────────────

export const SubscriptionTier = {
  COPILOT: 'copilot',
  AUTOPILOT: 'autopilot',
} as const;

// ── Derived type ─────────────────────────────────────────────────────────────

export type PriceVariant = 'list' | 'founding';

export const PRICE_VARIANTS = ['list', 'founding'] as const satisfies readonly PriceVariant[];

export type SubscriptionTierValue =
  | typeof SubscriptionTier.COPILOT
  | typeof SubscriptionTier.AUTOPILOT;

// ── Type guard ───────────────────────────────────────────────────────────────

const ALL_TIERS: readonly string[] = Object.values(SubscriptionTier);

/** Returns true when `value` is one of the two paid launch tiers. */
export function isSubscriptionTier(
  value: string,
): value is SubscriptionTierValue {
  return ALL_TIERS.includes(value);
}

export function isPriceVariant(value: string): value is PriceVariant {
  return PRICE_VARIANTS.includes(value as PriceVariant);
}

// ── Tier configuration map ──────────────────────────────────────────────────

export interface TierConfig {
  /** Immutable list/founding launch amounts. */
  baseByVariant: Readonly<Record<PriceVariant, number>>;
  /** Number of locations included in the base price. */
  included: number;
  /** Monthly per-location overage price in cents (0 = no overage allowed). */
  overageCents: number;
  /** Whether this tier allows adding multiple locations. */
  multiLocAllowed: boolean;
}

/**
 * Static tier configuration. Each entry maps a SubscriptionTierValue to its
 * billing parameters. Used by Checkout Session creation, quota checks, and
 * billing snapshot computation.
 *
 * VAL-BILLING-028: both tiers with exact immutable values.
 */
export const TIER_CONFIG: Record<SubscriptionTierValue, TierConfig> = {
  copilot: {
    baseByVariant: { list: 2900, founding: 1900 },
    included: 1,
    overageCents: 1500,
    multiLocAllowed: true,
  },
  autopilot: {
    baseByVariant: { list: 6900, founding: 4900 },
    included: 1,
    overageCents: 2000,
    multiLocAllowed: true,
  },
};

export interface ResolvedTierSnapshot {
  tier: SubscriptionTierValue;
  variant: PriceVariant;
  baseCents: number;
  overageCents: number;
  included: number;
}

/**
 * Canonical write-time billing resolver. Existing-account reads must continue
 * to use their stored snapshot instead of calling this function.
 */
export function resolveTierSnapshot(
  tier: SubscriptionTierValue,
  variant: PriceVariant,
): ResolvedTierSnapshot {
  if (!isSubscriptionTier(tier)) {
    throw new Error(`Unknown WS8 subscription tier: ${String(tier)}`);
  }
  if (!isPriceVariant(variant)) {
    throw new Error(`Unknown price variant: ${String(variant)}`);
  }

  const config = TIER_CONFIG[tier];
  return {
    tier,
    variant,
    baseCents: config.baseByVariant[variant],
    overageCents: config.overageCents,
    included: config.included,
  };
}

/**
 * Look up tier config by tier name. Throws for unknown tier values
 * (no silent fallback to a default tier — VAL-BILLING-029).
 */
export function getTierConfig(tier: SubscriptionTierValue): TierConfig {
  const config = TIER_CONFIG[tier];
  if (!config) {
    // This should be unreachable given the type, but guard anyway
    throw new Error(`Unknown subscription tier: ${tier}`);
  }
  return config;
}

/**
 * Safe lookup that returns undefined for unknown tiers instead of throwing.
 * Useful when parsing external input that might contain invalid values.
 */
export function lookupTierConfig(tier: string): TierConfig | undefined {
  if (!isSubscriptionTier(tier)) return undefined;
  return TIER_CONFIG[tier];
}
