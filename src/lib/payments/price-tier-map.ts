// Single owner of the WS8 Stripe Price-ID mapping. Environment values are read
// at call time so tests can safely stub them and long-lived processes never
// retain a partial registry built before configuration is available.

import {
  SubscriptionTier,
  isPriceVariant,
  isSubscriptionTier,
  resolveTierSnapshot,
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

/**
 * Code-owned archive of rotated immutable Stripe Prices. Add the outgoing ID
 * here before rotating an environment variable so webhook/reconciliation
 * reverse lookups remain valid forever. These entries are never used by the
 * forward lookup that creates new Stripe mutations.
 */
export type RetainedStripePrice =
  | {
      id: string;
      kind: 'base';
      tier: SubscriptionTierValue;
      variant: PriceVariant;
    }
  | {
      id: string;
      kind: 'overage';
      tier: SubscriptionTierValue;
      /** Immutable Stripe unit_amount used to recreate grandfathered items. */
      unitAmountCents: number;
    };

const RETAINED_STRIPE_PRICE_HISTORY: readonly RetainedStripePrice[] = [];

export type RetainedOverageStripePrice = Extract<
  RetainedStripePrice,
  { kind: 'overage' }
>;

export function retainedOverageStripePrices(): readonly RetainedOverageStripePrice[] {
  return RETAINED_STRIPE_PRICE_HISTORY.filter(
    (price): price is RetainedOverageStripePrice => price.kind === 'overage',
  );
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

/** Worker hard assertion and Next soft-drift check share this mapping guard. */
export function assertStripePriceIdsUnique(): void {
  knownPricesFor(RETAINED_STRIPE_PRICE_HISTORY);
}

interface KnownPrice {
  id: string | null;
  kind: StripePriceKind;
  tier: SubscriptionTierValue;
  variant?: PriceVariant;
}

function assertRetainedOverageAmounts(
  retainedHistory: readonly RetainedStripePrice[],
): void {
  const amountById = new Map<string, number>();
  for (const price of retainedHistory) {
    if (price.kind !== 'overage') continue;
    if (!Number.isSafeInteger(price.unitAmountCents) || price.unitAmountCents <= 0) {
      throw new Error(
        `[config] Retained Stripe overage Price ${price.id} has invalid unit amount`,
      );
    }
    const firstAmount = amountById.get(price.id);
    if (firstAmount !== undefined && firstAmount !== price.unitAmountCents) {
      throw new Error(
        `[config] Retained Stripe overage Price ${price.id} has conflicting unit amounts: `
        + `${firstAmount} and ${price.unitAmountCents}`,
      );
    }
    amountById.set(price.id, price.unitAmountCents);
  }
}

function knownPriceSemantics(price: KnownPrice): string {
  return price.kind === 'base'
    ? `${price.kind}:${price.tier}:${price.variant ?? 'missing'}`
    : `${price.kind}:${price.tier}`;
}

function assertKnownPriceMappingsConsistent(
  prices: readonly KnownPrice[],
): void {
  const semanticsById = new Map<string, string>();
  for (const price of prices) {
    if (!price.id) continue;
    const semantics = knownPriceSemantics(price);
    const firstSemantics = semanticsById.get(price.id);
    if (firstSemantics && firstSemantics !== semantics) {
      throw new Error(
        `[config] Stripe Price ID ${price.id} has conflicting mappings: `
        + `${firstSemantics} and ${semantics}`,
      );
    }
    semanticsById.set(price.id, semantics);
  }
}

function knownPricesFor(
  retainedHistory: readonly RetainedStripePrice[],
): KnownPrice[] {
  assertRetainedOverageAmounts(retainedHistory);
  const prices: KnownPrice[] = [
    ...configuredPrices(),
    ...retainedHistory.map((price): KnownPrice => ({
      id: price.id,
      kind: price.kind,
      tier: price.tier,
      variant: price.kind === 'base' ? price.variant : undefined,
    })),
  ];
  assertKnownPriceMappingsConsistent(prices);
  return prices;
}

/**
 * Builds the Price lookup surface around an explicit retained-history list.
 * The default production instance uses RETAINED_STRIPE_PRICE_HISTORY; passing
 * a registry keeps rotation behavior pure and directly testable.
 */
export function createPriceTierMap(
  retainedHistory: readonly RetainedStripePrice[] = RETAINED_STRIPE_PRICE_HISTORY,
) {
  const knownPrices = (): KnownPrice[] => knownPricesFor(retainedHistory);

  return {
    /**
     * Variant-aware forward lookup. Deliberately reads only the six live env
     * IDs; history can recognize old provider state but can never create it.
     */
    priceIdFor(
      tier: SubscriptionTierValue,
      variant: PriceVariant,
      kind: StripePriceKind,
    ): string | null {
      // Forward writes must also fail closed if the code-owned historical
      // registry conflicts with a live ID. Next instrumentation reports config
      // drift but is intentionally non-fatal, so the write seam enforces it.
      knownPrices();
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
    },

    /**
     * Resolves the Price that preserves an account's stored overage cents.
     * Current cents use the live env ID; grandfathered cents require an
     * explicitly retained immutable Price and never fall forward to today's
     * more expensive Price.
     */
    overagePriceIdForStoredCents(
      tier: SubscriptionTierValue,
      storedOveragePriceCents: number,
    ): string | null {
      knownPrices();
      if (!isSubscriptionTier(tier)) {
        throw new Error(`Unknown WS8 subscription tier: ${String(tier)}`);
      }
      if (
        !Number.isSafeInteger(storedOveragePriceCents)
        || storedOveragePriceCents <= 0
      ) {
        throw new Error('Stored overage Price cents must be a positive safe integer');
      }

      const currentSnapshot = resolveTierSnapshot(tier, 'list');
      if (currentSnapshot.overageCents === storedOveragePriceCents) {
        return configuredPrices().find(
          (price) => price.kind === 'overage' && price.tier === tier,
        )?.id ?? null;
      }

      const retained = retainedHistory.find(
        (price) => price.kind === 'overage'
          && price.tier === tier
          && price.unitAmountCents === storedOveragePriceCents,
      );
      return retained?.id ?? null;
    },

    basePriceInfoForId(priceId: string | null | undefined): BasePriceInfo | null {
      if (!priceId) return null;
      const match = knownPrices().find(
        (price) => price.kind === 'base' && price.id === priceId,
      );
      if (!match?.variant) return null;
      return { tier: match.tier, variant: match.variant };
    },

    overagePriceInfoForId(
      priceId: string | null | undefined,
    ): OveragePriceInfo | null {
      if (!priceId) return null;
      const match = knownPrices().find(
        (price) => price.kind === 'overage' && price.id === priceId,
      );
      return match ? { tier: match.tier } : null;
    },

    basePriceIdSet(): Set<string> {
      return new Set(knownPrices()
        .filter((price) => price.kind === 'base' && price.id)
        .map((price) => price.id!));
    },

    overagePriceIdSet(): Set<string> {
      return new Set(knownPrices()
        .filter((price) => price.kind === 'overage' && price.id)
        .map((price) => price.id!));
    },

    isOveragePriceId(priceId: string | null | undefined): boolean {
      return Boolean(
        priceId
        && knownPrices().some(
          (price) => price.kind === 'overage' && price.id === priceId,
        ),
      );
    },
  };
}

const priceTierMap = createPriceTierMap();

export function priceIdFor(
  tier: SubscriptionTierValue,
  variant: PriceVariant,
  kind: StripePriceKind,
): string | null {
  return priceTierMap.priceIdFor(tier, variant, kind);
}

export function basePriceInfoForId(
  priceId: string | null | undefined,
): BasePriceInfo | null {
  return priceTierMap.basePriceInfoForId(priceId);
}

export function overagePriceInfoForId(
  priceId: string | null | undefined,
): OveragePriceInfo | null {
  return priceTierMap.overagePriceInfoForId(priceId);
}

export function overagePriceIdForStoredCents(
  tier: SubscriptionTierValue,
  storedOveragePriceCents: number,
): string | null {
  return priceTierMap.overagePriceIdForStoredCents(
    tier,
    storedOveragePriceCents,
  );
}

/** Current plus retained historical base Price IDs. */
export function basePriceIdSet(): Set<string> {
  return priceTierMap.basePriceIdSet();
}

/** Current plus retained historical overage Price IDs. */
export function overagePriceIdSet(): Set<string> {
  return priceTierMap.overagePriceIdSet();
}

export function isOveragePriceId(priceId: string | null | undefined): boolean {
  return priceTierMap.isOveragePriceId(priceId);
}
