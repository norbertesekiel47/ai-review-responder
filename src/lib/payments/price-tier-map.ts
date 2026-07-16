// Single owner of the WS8 Stripe Price-ID mapping. Environment values are read
// at call time so tests can safely stub them and long-lived processes never
// retain a partial registry built before configuration is available.

import {
  SubscriptionTier,
  isPriceVariant,
  isSubscriptionTier,
  type PriceVariant,
  type SubscriptionTierValue,
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

type StripePriceEnvVar = (typeof STRIPE_PRICE_ENV_VARS)[number];
export type StripePriceKind = 'base' | 'overage';

export interface BasePriceInfo {
  tier: SubscriptionTierValue;
  variant: PriceVariant;
}

export interface OveragePriceInfo {
  tier: SubscriptionTierValue;
}

interface ConfiguredPrice {
  env: StripePriceEnvVar;
  id: string | null;
  kind: StripePriceKind;
  tier: SubscriptionTierValue;
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
  tier: SubscriptionTierValue,
  variant: PriceVariant,
  kind: StripePriceKind,
): string | null {
  if (!isSubscriptionTier(tier)) {
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

/** Configured base Price IDs. */
export function basePriceIdSet(): Set<string> {
  return new Set(configuredPrices()
    .filter((price) => price.kind === 'base' && price.id)
    .map((price) => price.id!));
}

/** Configured overage Price IDs. */
export function overagePriceIdSet(): Set<string> {
  return new Set(configuredPrices()
    .filter((price) => price.kind === 'overage' && price.id)
    .map((price) => price.id!));
}

export function isOveragePriceId(priceId: string | null | undefined): boolean {
  return Boolean(priceId && overagePriceIdSet().has(priceId));
}
