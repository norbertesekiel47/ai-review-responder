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

const PRICE_VARIANTS = ['list', 'founding'] as const satisfies readonly PriceVariant[];

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

/**
 * Single authoritative autopilot-entitlement predicate — the tier analogue of
 * `subscriptionGrantsFullAccess` for status. Every "does this tier permit
 * autonomous posting?" decision routes through here (2026-07-16 review
 * finding #6); never compare tiers to `SubscriptionTier.AUTOPILOT` inline.
 * Deliberately DISTINCT from `autopilotPurchasable()` (tier-purchasability),
 * which gates NEW purchases only — an existing subscriber keeps entitlement
 * during a sales pause.
 */
export function tierGrantsAutopilot(tier: string | null | undefined): boolean {
  return tier === SubscriptionTier.AUTOPILOT;
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
    baseByVariant: { list: 7900, founding: 4900 },
    included: 1,
    overageCents: 7900,
    multiLocAllowed: true,
  },
  autopilot: {
    baseByVariant: { list: 14900, founding: 9900 },
    included: 1,
    overageCents: 14900,
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

// ── Tier order and change direction ─────────────────────────────────────────

/**
 * Ascending AUTONOMY, not price. Copilot is owner-approves-everything;
 * Autopilot grants bounded autonomy.
 *
 * The owner of tier order for PRODUCT code: `plan-presentation.ts`,
 * `BillingPanel.tsx` and `onboarding/pay/plan-options.ts` all import it, and
 * #1054 collapsed their three separate copies into this one. Import it; do not
 * re-declare the array beside a price map, which is how the direction bug got
 * three homes in the first place.
 *
 * Known remaining copy, deliberately not collapsed here (red team round 2
 * RT-2): `scripts/verify-stripe-price-parity.ts:16` declares its own `TIERS`
 * to iterate Stripe Price shapes. It is a script, not product code, and
 * pulling it in is out of this change's surface — but it IS the same concept
 * and should import this constant when that file is next touched.
 * `TiersSection.tsx:13` is NOT a copy: its `ORDER` is over a local
 * `Mode = 'autopilot' | 'copilot'` animation union, a different concept that
 * happens to share both element names.
 */
export const SUBSCRIPTION_TIER_ORDER = [
  SubscriptionTier.COPILOT,
  SubscriptionTier.AUTOPILOT,
] as const satisfies readonly SubscriptionTierValue[];

export type TierChangeDirection = 'up' | 'down' | 'same';

export function tierChangeDirection(
  from: SubscriptionTierValue,
  to: SubscriptionTierValue,
): TierChangeDirection {
  const fromIndex = SUBSCRIPTION_TIER_ORDER.indexOf(from);
  const toIndex = SUBSCRIPTION_TIER_ORDER.indexOf(to);
  if (toIndex === fromIndex) return 'same';
  return toIndex > fromIndex ? 'up' : 'down';
}
