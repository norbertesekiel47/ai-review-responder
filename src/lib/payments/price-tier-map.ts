// Single owner of the WS8 Stripe Price-ID mapping. Environment values are read
// at call time so tests can safely stub them and long-lived processes never
// retain a partial registry built before configuration is available.

import {
  SubscriptionTier,
  isPriceVariant,
  isWs8SubscriptionTier,
  type PriceVariant,
  type SubscriptionTierValue,
  type Ws8SubscriptionTier,
} from '@/lib/accounts/tier-config';

/** The complete launch Price contract. Keep historical launch IDs resolvable. */
export const STRIPE_PRICE_ENV_VARS = [
  'STRIPE_PRICE_COPILOT_LIST',
  'STRIPE_PRICE_COPILOT_FOUNDING',
  'STRIPE_PRICE_AUTOPILOT_LIST',
  'STRIPE_PRICE_AUTOPILOT_FOUNDING',
  'STRIPE_PRICE_COPILOT_OVERAGE',
  'STRIPE_PRICE_AUTOPILOT_OVERAGE',
] as const;

export type StripePriceEnvVar = (typeof STRIPE_PRICE_ENV_VARS)[number];
export type StripePriceKind = 'base' | 'overage';

export interface BasePriceInfo {
  tier: Ws8SubscriptionTier;
  variant: PriceVariant;
}

export interface OveragePriceInfo {
  tier: Ws8SubscriptionTier;
}

interface ConfiguredPrice {
  env: StripePriceEnvVar;
  id: string | null;
  kind: StripePriceKind;
  tier: Ws8SubscriptionTier;
  variant?: PriceVariant;
}

function configuredId(env: StripePriceEnvVar): string | null {
  const value = process.env[env];
  return value && value.trim().length > 0 ? value : null;
}

function configuredPrices(): ConfiguredPrice[] {
  const prices: ConfiguredPrice[] = [
    {
      env: 'STRIPE_PRICE_COPILOT_LIST',
      id: configuredId('STRIPE_PRICE_COPILOT_LIST'),
      kind: 'base',
      tier: SubscriptionTier.COPILOT,
      variant: 'list',
    },
    {
      env: 'STRIPE_PRICE_COPILOT_FOUNDING',
      id: configuredId('STRIPE_PRICE_COPILOT_FOUNDING'),
      kind: 'base',
      tier: SubscriptionTier.COPILOT,
      variant: 'founding',
    },
    {
      env: 'STRIPE_PRICE_AUTOPILOT_LIST',
      id: configuredId('STRIPE_PRICE_AUTOPILOT_LIST'),
      kind: 'base',
      tier: SubscriptionTier.AUTOPILOT,
      variant: 'list',
    },
    {
      env: 'STRIPE_PRICE_AUTOPILOT_FOUNDING',
      id: configuredId('STRIPE_PRICE_AUTOPILOT_FOUNDING'),
      kind: 'base',
      tier: SubscriptionTier.AUTOPILOT,
      variant: 'founding',
    },
    {
      env: 'STRIPE_PRICE_COPILOT_OVERAGE',
      id: configuredId('STRIPE_PRICE_COPILOT_OVERAGE'),
      kind: 'overage',
      tier: SubscriptionTier.COPILOT,
    },
    {
      env: 'STRIPE_PRICE_AUTOPILOT_OVERAGE',
      id: configuredId('STRIPE_PRICE_AUTOPILOT_OVERAGE'),
      kind: 'overage',
      tier: SubscriptionTier.AUTOPILOT,
    },
  ];
  assertUniqueConfiguredPrices(prices);
  return prices;
}

function assertUniqueConfiguredPrices(prices: readonly ConfiguredPrice[]): void {
  const firstEnvById = new Map<string, StripePriceEnvVar>();
  for (const price of prices) {
    if (!price.id) continue;
    const firstEnv = firstEnvById.get(price.id);
    if (firstEnv) {
      throw new Error(
        `[config] Stripe Price IDs must be unique: ${firstEnv} duplicates ${price.env}`,
      );
    }
    firstEnvById.set(price.id, price.env);
  }
}

/** Worker hard assertion and Next soft-drift check share this duplicate guard. */
export function assertStripePriceIdsUnique(): void {
  configuredPrices();
}

/**
 * Variant-aware forward lookup. The variant remains required for overage even
 * though both account variants intentionally share one overage Price per tier.
 */
export function priceIdFor(
  tier: Ws8SubscriptionTier,
  variant: PriceVariant,
  kind: StripePriceKind,
): string | null {
  if (!isWs8SubscriptionTier(tier)) {
    throw new Error(`Unknown WS8 subscription tier: ${String(tier)}`);
  }
  if (!isPriceVariant(variant)) {
    throw new Error(`Unknown price variant: ${String(variant)}`);
  }
  if (kind !== 'base' && kind !== 'overage') {
    throw new Error(`Unknown Stripe Price kind: ${String(kind)}`);
  }
  const match = configuredPrices().find(
    (price) =>
      price.tier === tier &&
      price.kind === kind &&
      (kind === 'overage' || price.variant === variant),
  );
  return match?.id ?? null;
}

export function basePriceInfoForId(
  priceId: string | null | undefined,
): BasePriceInfo | null {
  if (!priceId) return null;
  const match = configuredPrices().find(
    (price) => price.kind === 'base' && price.id === priceId,
  );
  if (!match?.variant) return null;
  return { tier: match.tier, variant: match.variant };
}

export function overagePriceInfoForId(
  priceId: string | null | undefined,
): OveragePriceInfo | null {
  if (!priceId) return null;
  const match = configuredPrices().find(
    (price) => price.kind === 'overage' && price.id === priceId,
  );
  return match ? { tier: match.tier } : null;
}

// WS8_TRANSITION_ONLY: legacy maps/APIs keep Tasks 2-8 type-safe while their
// callers migrate. They preserve legacy identity and never map an old tier to a
// WS8 tier. Task 9 deletes this entire compatibility section.
function legacyBaseEnvMap(): Partial<Record<SubscriptionTierValue, string | undefined>> {
  return {
    basic: process.env.STRIPE_PRICE_BASIC,
    standard: process.env.STRIPE_PRICE_STANDARD,
    premium: process.env.STRIPE_PRICE_PREMIUM,
    founders: process.env.STRIPE_PRICE_FOUNDING,
  };
}

function legacyOverageEnvMap(): Partial<Record<SubscriptionTierValue, string | undefined>> {
  return {
    basic: undefined,
    standard: process.env.STRIPE_PRICE_STANDARD_OVERAGE,
    premium: process.env.STRIPE_PRICE_PREMIUM_OVERAGE,
    founders: process.env.STRIPE_PRICE_FOUNDERS_OVERAGE,
  };
}

/** @deprecated WS8_TRANSITION_ONLY — use priceIdFor with an account variant. */
export function basePriceIdForTier(tier: SubscriptionTierValue): string | null {
  return legacyBaseEnvMap()[tier] || null;
}

/** @deprecated WS8_TRANSITION_ONLY — use priceIdFor with an account variant. */
export function overagePriceIdForTier(tier: SubscriptionTierValue): string | null {
  return legacyOverageEnvMap()[tier] || null;
}

/** @deprecated WS8_TRANSITION_ONLY — use basePriceInfoForId. */
export function tierForBasePriceId(
  priceId: string | null | undefined,
): SubscriptionTierValue | null {
  if (!priceId) return null;
  const legacy = Object.entries(legacyBaseEnvMap()) as [
    SubscriptionTierValue,
    string | undefined,
  ][];
  return legacy.find(([, id]) => id && id === priceId)?.[0] ?? null;
}

/** Configured base Price IDs, including transition-only legacy IDs. */
export function basePriceIdSet(): Set<string> {
  const canonical = configuredPrices()
    .filter((price) => price.kind === 'base' && price.id)
    .map((price) => price.id!);
  const legacy = Object.values(legacyBaseEnvMap()).filter(
    (id): id is string => Boolean(id),
  );
  return new Set([...canonical, ...legacy]);
}

/** Configured overage Price IDs, including transition-only legacy IDs. */
export function overagePriceIdSet(): Set<string> {
  const canonical = configuredPrices()
    .filter((price) => price.kind === 'overage' && price.id)
    .map((price) => price.id!);
  const legacy = Object.values(legacyOverageEnvMap()).filter(
    (id): id is string => Boolean(id),
  );
  return new Set([...canonical, ...legacy]);
}

export function isOveragePriceId(priceId: string | null | undefined): boolean {
  return Boolean(priceId && overagePriceIdSet().has(priceId));
}
