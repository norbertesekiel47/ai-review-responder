// src/lib/payments/price-tier-map.ts
//
// Single owner of the SubscriptionTier <-> Stripe price-ID mapping. Every
// tier/price lookup (checkout, tier-change, the subscription webhook, the
// overage worker, the reconciliation poller) sources from here so the mapping
// has one authoritative representation.
//
// Env is read at call time (not memoized at import) so tests can stub
// process.env per case; presence-validation stays with the worker's boot-time
// env assertions (worker/config/startup-assert.ts).
//
// Validation contract: VAL-BILLING-009, VAL-BILLING-030, VAL-BILLING-032,
//   VAL-BILLING-055.

import { type SubscriptionTierValue } from '@/lib/accounts/tier-config';

/**
 * The seven Stripe price env vars this module reads. Single owner of the
 * list — the worker boot assertions and the Next.js instrumentation
 * soft-assert derive from it, so adding a tier means adding it HERE and in
 * the env maps below, nowhere else.
 */
export const STRIPE_PRICE_ENV_VARS = [
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_STANDARD',
  'STRIPE_PRICE_PREMIUM',
  'STRIPE_PRICE_STANDARD_OVERAGE',
  'STRIPE_PRICE_PREMIUM_OVERAGE',
  'STRIPE_PRICE_FOUNDERS_OVERAGE',
] as const;

function baseEnvMap(): Record<SubscriptionTierValue, string | undefined> {
  return {
    basic: process.env.STRIPE_PRICE_BASIC,
    standard: process.env.STRIPE_PRICE_STANDARD,
    premium: process.env.STRIPE_PRICE_PREMIUM,
    // The 'founders' tier uses the STRIPE_PRICE_FOUNDING env var (naming quirk
    // documented in tier-config.ts).
    founders: process.env.STRIPE_PRICE_FOUNDING,
  };
}

function overageEnvMap(): Record<SubscriptionTierValue, string | undefined> {
  return {
    basic: undefined, // basic tier has no overage
    standard: process.env.STRIPE_PRICE_STANDARD_OVERAGE,
    premium: process.env.STRIPE_PRICE_PREMIUM_OVERAGE,
    founders: process.env.STRIPE_PRICE_FOUNDERS_OVERAGE,
  };
}

/** tier -> base price ID, or null when the env var is unset/empty. */
export function basePriceIdForTier(tier: SubscriptionTierValue): string | null {
  return baseEnvMap()[tier] || null;
}

/** tier -> overage price ID, or null. `basic` is always null. */
export function overagePriceIdForTier(tier: SubscriptionTierValue): string | null {
  return overageEnvMap()[tier] || null;
}

/**
 * base price ID -> tier. The reverse map is built ONLY from non-empty IDs, so
 * an empty/undefined price ID can never collide on a shared '' key. Unknown or
 * empty input returns null.
 */
export function tierForBasePriceId(
  priceId: string | null | undefined,
): SubscriptionTierValue | null {
  if (!priceId) return null;
  const entries = Object.entries(baseEnvMap()) as [SubscriptionTierValue, string | undefined][];
  for (const [tier, id] of entries) {
    if (id && id === priceId) return tier;
  }
  return null;
}

/** The set of configured (non-empty) base price IDs. */
export function basePriceIdSet(): Set<string> {
  return new Set(
    Object.values(baseEnvMap()).filter((id): id is string => Boolean(id)),
  );
}

/** The set of configured (non-empty) overage price IDs. */
export function overagePriceIdSet(): Set<string> {
  return new Set(
    Object.values(overageEnvMap()).filter((id): id is string => Boolean(id)),
  );
}

/**
 * True when priceId is one of the configured overage price IDs. Builds the set
 * on each call; for bulk membership checks (e.g. scanning many subscription
 * items) call `overagePriceIdSet()` once and reuse the result instead.
 */
export function isOveragePriceId(priceId: string | null | undefined): boolean {
  if (!priceId) return false;
  return overagePriceIdSet().has(priceId);
}
