// src/lib/accounts/tier-config.ts
//
// Central SubscriptionTier type/const and tier configuration map.
// Every piece of code that references subscription tier values must use
// these — never bare string literals like 'standard' or 'founding'.
//
// Validation contract: VAL-BILLING-028, VAL-BILLING-042.


// ── Const object (enum-like) ──────────────────────────────────────────────────

export const SubscriptionTier = {
  COPILOT: 'copilot',
  AUTOPILOT: 'autopilot',
  // WS8_TRANSITION_ONLY: retained until Task 9 mechanically contracts every
  // legacy caller. These values are not mapped to either launch tier.
  BASIC: 'basic',
  STANDARD: 'standard',
  PREMIUM: 'premium',
  FOUNDERS: 'founders',
} as const;

// ── Derived type ─────────────────────────────────────────────────────────────

export type PriceVariant = 'list' | 'founding';

export const PRICE_VARIANTS = ['list', 'founding'] as const satisfies readonly PriceVariant[];

export type Ws8SubscriptionTier =
  | typeof SubscriptionTier.COPILOT
  | typeof SubscriptionTier.AUTOPILOT;

/** WS8_TRANSITION_ONLY: legacy caller type; Task 9 replaces it with WS8 tiers. */
export type SubscriptionTierValue =
  | typeof SubscriptionTier.BASIC
  | typeof SubscriptionTier.STANDARD
  | typeof SubscriptionTier.PREMIUM
  | typeof SubscriptionTier.FOUNDERS;

export type TransitionSubscriptionTierValue =
  | Ws8SubscriptionTier
  | SubscriptionTierValue;

// ── Type guard ───────────────────────────────────────────────────────────────

const ALL_TIERS: readonly string[] = Object.values(SubscriptionTier);

/** Returns true when `value` is one of the additive transition tier values. */
export function isSubscriptionTier(
  value: string,
): value is TransitionSubscriptionTierValue {
  return ALL_TIERS.includes(value);
}

export function isPriceVariant(value: string): value is PriceVariant {
  return PRICE_VARIANTS.includes(value as PriceVariant);
}

export function isWs8SubscriptionTier(value: string): value is Ws8SubscriptionTier {
  return value === SubscriptionTier.COPILOT || value === SubscriptionTier.AUTOPILOT;
}

// ── Tier configuration map ──────────────────────────────────────────────────

export interface TierConfig {
  /**
   * WS8_TRANSITION_ONLY scalar used by legacy callers until Task 9. For WS8
   * tiers it is derived from `baseByVariant.list`, never a second price owner.
   */
  baseCents: number;
  /** Immutable list/founding launch amounts. Present only on WS8 tiers. */
  baseByVariant?: Readonly<Record<PriceVariant, number>>;
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
export const TIER_CONFIG: Record<TransitionSubscriptionTierValue, TierConfig> = {
  copilot: {
    baseByVariant: { list: 2900, founding: 1900 },
    get baseCents() {
      return this.baseByVariant!.list;
    },
    included: 1,
    overageCents: 1500,
    multiLocAllowed: true,
  },
  autopilot: {
    baseByVariant: { list: 6900, founding: 4900 },
    get baseCents() {
      return this.baseByVariant!.list;
    },
    included: 1,
    overageCents: 2000,
    multiLocAllowed: true,
  },
  // WS8_TRANSITION_ONLY: legacy configuration remains byte-for-byte until the
  // Task 9 contraction. It does not participate in resolveTierSnapshot.
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

export interface ResolvedTierSnapshot {
  tier: Ws8SubscriptionTier;
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
  tier: Ws8SubscriptionTier,
  variant: PriceVariant,
): ResolvedTierSnapshot {
  if (!isWs8SubscriptionTier(tier)) {
    throw new Error(`Unknown WS8 subscription tier: ${String(tier)}`);
  }
  if (!isPriceVariant(variant)) {
    throw new Error(`Unknown price variant: ${String(variant)}`);
  }

  const config = TIER_CONFIG[tier];
  const baseByVariant = config.baseByVariant;
  if (!baseByVariant) {
    throw new Error(`Missing variant pricing for WS8 subscription tier: ${tier}`);
  }

  return {
    tier,
    variant,
    baseCents: baseByVariant[variant],
    overageCents: config.overageCents,
    included: config.included,
  };
}

/**
 * Look up tier config by tier name. Throws for unknown tier values
 * (no silent fallback to a default tier — VAL-BILLING-029).
 */
export function getTierConfig(tier: TransitionSubscriptionTierValue): TierConfig {
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
