// src/lib/accounts/tier-config.ts
//
// Central SubscriptionTier type/const and tier configuration map.
// Every piece of code that references subscription tier values must use
// these — never bare string literals like 'standard' or 'founding'.
//
// IMPORTANT: The tier previously called 'founding' in the legacy codebase
// is now 'founders' in the multi-location model. The spec tier table uses
// 'founders'; the billing system uses STRIPE_PRICE_FOUNDING env var but
// the application-level enum is 'founders'.
//
// Validation contract: VAL-BILLING-028, VAL-BILLING-042.


// ── Const object (enum-like) ──────────────────────────────────────────────────

export const SubscriptionTier = {
  BASIC: 'basic',
  STANDARD: 'standard',
  PREMIUM: 'premium',
  FOUNDERS: 'founders',
} as const;

// ── Derived type ─────────────────────────────────────────────────────────────

export type SubscriptionTierValue =
  (typeof SubscriptionTier)[keyof typeof SubscriptionTier];

// ── Type guard ───────────────────────────────────────────────────────────────

const ALL_TIERS: readonly string[] = Object.values(SubscriptionTier);

/** Returns true when `value` is one of the four canonical subscription tiers. */
export function isSubscriptionTier(value: string): value is SubscriptionTierValue {
  return ALL_TIERS.includes(value);
}

// ── Tier configuration map ──────────────────────────────────────────────────

export interface TierConfig {
  /** Monthly base price in cents (e.g. 2900 = $29.00). */
  baseCents: number;
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
 * VAL-BILLING-028: all 4 tiers with correct values.
 */
export const TIER_CONFIG: Record<SubscriptionTierValue, TierConfig> = {
  basic: {
    baseCents: 2900,
    included: 1,
    overageCents: 0,
    multiLocAllowed: false,
  },
  standard: {
    baseCents: 7900,
    included: 1,
    overageCents: 2500,
    multiLocAllowed: true,
  },
  premium: {
    baseCents: 19900,
    included: 5,
    overageCents: 2000,
    multiLocAllowed: true,
  },
  founders: {
    baseCents: 1900,
    included: 1,
    overageCents: 2500,
    multiLocAllowed: true,
  },
};

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
