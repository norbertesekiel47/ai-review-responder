import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { findOverageItem } from '../overage-item';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function makeItem({
  id,
  priceId,
  unit_amount,
  lookup_key,
  nickname,
  metadata,
}: {
  id: string;
  priceId: string;
  unit_amount?: number;
  lookup_key?: string;
  nickname?: string;
  metadata?: Record<string, string>;
}): Stripe.SubscriptionItem {
  return {
    id,
    object: 'subscription_item',
    price: {
      id: priceId,
      object: 'price',
      unit_amount: unit_amount ?? null,
      lookup_key: lookup_key ?? null,
      nickname: nickname ?? null,
      metadata: metadata ?? {},
      // minimal required Price fields
      active: true,
      billing_scheme: 'per_unit',
      created: 0,
      currency: 'usd',
      livemode: false,
      product: 'prod_test',
      recurring: null,
      tax_behavior: null,
      tiers_mode: null,
      transform_quantity: null,
      type: 'one_time',
      unit_amount_decimal: unit_amount != null ? String(unit_amount) : null,
      custom_unit_amount: null,
    } as unknown as Stripe.Price,
    quantity: 1,
    created: 0,
    metadata: {},
    subscription: 'sub_test',
  } as unknown as Stripe.SubscriptionItem;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findOverageItem', () => {
  const defaultOptions = {
    overagePriceIds: new Set<string>(),
    basePriceIds: new Set<string>(),
    storedOveragePriceCents: 0,
  };

  // -------------------------------------------------------------------------
  // Env price-ID match
  // -------------------------------------------------------------------------

  it('matches by env overage price ID', () => {
    const item = makeItem({ id: 'si_overage', priceId: 'price_overage_env' });
    const found = findOverageItem([item], {
      ...defaultOptions,
      overagePriceIds: new Set(['price_overage_env']),
    });
    expect(found).toBe(item);
  });

  it('returns undefined when price ID is not in overagePriceIds', () => {
    const item = makeItem({ id: 'si_other', priceId: 'price_other' });
    const found = findOverageItem([item], {
      ...defaultOptions,
      overagePriceIds: new Set(['price_different']),
    });
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Keyword descriptor matches
  // -------------------------------------------------------------------------

  it('matches by lookup_key containing "overage"', () => {
    // Use a value where "overage" is a discrete word token so \b boundaries apply.
    const item = makeItem({ id: 'si_1', priceId: 'price_1', lookup_key: 'overage location' });
    const found = findOverageItem([item], defaultOptions);
    expect(found).toBe(item);
  });

  it('matches by nickname containing "additional"', () => {
    const item = makeItem({ id: 'si_2', priceId: 'price_2', nickname: 'Additional Location' });
    const found = findOverageItem([item], defaultOptions);
    expect(found).toBe(item);
  });

  it('matches by metadata.billing_role containing "extra"', () => {
    const item = makeItem({ id: 'si_3', priceId: 'price_3', metadata: { billing_role: 'extra' } });
    const found = findOverageItem([item], defaultOptions);
    expect(found).toBe(item);
  });

  it('matches by metadata.role containing "add-on"', () => {
    const item = makeItem({ id: 'si_4', priceId: 'price_4', metadata: { role: 'add-on' } });
    const found = findOverageItem([item], defaultOptions);
    expect(found).toBe(item);
  });

  it('matches by nickname containing "addon" (no hyphen variant)', () => {
    const item = makeItem({ id: 'si_5', priceId: 'price_5', nickname: 'addon plan' });
    const found = findOverageItem([item], defaultOptions);
    expect(found).toBe(item);
  });

  // -------------------------------------------------------------------------
  // Unit-amount match — multi-item only
  // -------------------------------------------------------------------------

  it('matches by unit_amount when more than one item is present', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 4900 });
    const overage = makeItem({ id: 'si_overage', priceId: 'price_overage', unit_amount: 2500 });
    const found = findOverageItem([base, overage], {
      ...defaultOptions,
      storedOveragePriceCents: 2500,
    });
    expect(found).toBe(overage);
  });

  it('does NOT match by unit_amount for a single-item subscription', () => {
    const item = makeItem({ id: 'si_only', priceId: 'price_only', unit_amount: 2500 });
    const found = findOverageItem([item], {
      ...defaultOptions,
      storedOveragePriceCents: 2500,
    });
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Base-exclusion runs FIRST
  // -------------------------------------------------------------------------

  it('never selects the base item even when its unit_amount collides with stored overage cents', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 2500 });
    const found = findOverageItem([base], {
      overagePriceIds: new Set<string>(),
      basePriceIds: new Set(['price_base']),
      storedOveragePriceCents: 2500,
    });
    expect(found).toBeUndefined();
  });

  it('excludes base item by ID even in a multi-item subscription with unit_amount collision', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 2500 });
    const unrelated = makeItem({ id: 'si_other', priceId: 'price_other', unit_amount: 9900 });
    // Two items but the only one matching storedOveragePriceCents is the base — still excluded
    const found = findOverageItem([base, unrelated], {
      overagePriceIds: new Set<string>(),
      basePriceIds: new Set(['price_base']),
      storedOveragePriceCents: 2500,
    });
    expect(found).toBeUndefined();
  });

  it('excludes a base item even when its descriptor matches an overage keyword', () => {
    // Proves base-exclusion runs BEFORE the keyword heuristic: a future refactor that
    // reorders these two checks would wrongly return the base item and this test catches it.
    const base = makeItem({ id: 'si_base', priceId: 'price_base', nickname: 'overage seats' });
    const found = findOverageItem([base], {
      overagePriceIds: new Set<string>(),
      basePriceIds: new Set(['price_base']),
      storedOveragePriceCents: 0,
    });
    expect(found).toBeUndefined();
  });

  it('returns the real overage item when a base item with an overage keyword coexists with it', () => {
    // Multi-item variant: base-exclusion must filter the base item first so the
    // keyword scan then correctly identifies the non-base overage item.
    const base = makeItem({ id: 'si_base', priceId: 'price_base', nickname: 'overage seats' });
    const realOverage = makeItem({ id: 'si_overage', priceId: 'price_overage', nickname: 'extra location' });
    const found = findOverageItem([base, realOverage], {
      overagePriceIds: new Set<string>(),
      basePriceIds: new Set(['price_base']),
      storedOveragePriceCents: 0,
    });
    expect(found).toBe(realOverage);
  });

  // -------------------------------------------------------------------------
  // Returns undefined when nothing matches
  // -------------------------------------------------------------------------

  it('returns undefined for an empty item list', () => {
    const found = findOverageItem([], defaultOptions);
    expect(found).toBeUndefined();
  });

  it('returns undefined when no item matches any heuristic', () => {
    const item = makeItem({ id: 'si_1', priceId: 'price_1', unit_amount: 9900, nickname: 'Base Plan' });
    const found = findOverageItem([item], {
      ...defaultOptions,
      storedOveragePriceCents: 9900,
      // single item → unit-amount guard prevents match
    });
    expect(found).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Priority: env-ID > keyword > unit-amount
  // -------------------------------------------------------------------------

  it('prefers env-ID match over keyword match', () => {
    const byKeyword = makeItem({ id: 'si_keyword', priceId: 'price_kw', nickname: 'overage' });
    const byEnvId = makeItem({ id: 'si_env', priceId: 'price_env_overage' });
    const found = findOverageItem([byKeyword, byEnvId], {
      overagePriceIds: new Set(['price_env_overage']),
      basePriceIds: new Set<string>(),
      storedOveragePriceCents: 0,
    });
    expect(found).toBe(byEnvId);
  });

  it('prefers env-ID match over unit-amount match', () => {
    const byUnitAmount = makeItem({ id: 'si_unit', priceId: 'price_unit', unit_amount: 2500 });
    const byEnvId = makeItem({ id: 'si_env', priceId: 'price_env_overage', unit_amount: 9900 });
    // Two items so unit-amount guard passes
    const found = findOverageItem([byUnitAmount, byEnvId], {
      overagePriceIds: new Set(['price_env_overage']),
      basePriceIds: new Set<string>(),
      storedOveragePriceCents: 2500,
    });
    expect(found).toBe(byEnvId);
  });

  it('prefers keyword match over unit-amount match', () => {
    const byUnitAmount = makeItem({ id: 'si_unit', priceId: 'price_unit', unit_amount: 2500 });
    // Use a space-separated keyword so \b word boundaries fire correctly.
    const byKeyword = makeItem({ id: 'si_kw', priceId: 'price_kw', lookup_key: 'extra seat', unit_amount: 9900 });
    // Two items so unit-amount guard passes for byUnitAmount; keyword should still win.
    const found = findOverageItem([byUnitAmount, byKeyword], {
      overagePriceIds: new Set<string>(),
      basePriceIds: new Set<string>(),
      storedOveragePriceCents: 2500,
    });
    expect(found).toBe(byKeyword);
  });
});
