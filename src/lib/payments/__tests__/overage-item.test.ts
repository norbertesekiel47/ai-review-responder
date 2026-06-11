import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveOverageItem,
  overageItemMutationParams,
  OVERAGE_BILLING_ROLE,
} from '../overage-item';

// ---------------------------------------------------------------------------
// Env stubs — the module reads the price-ID sets itself (call-time env, same
// semantics as price-tier-map). Tests stub env exactly as price-tier-map's
// own tests do.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_STANDARD',
  'STRIPE_PRICE_PREMIUM',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_STANDARD_OVERAGE',
  'STRIPE_PRICE_PREMIUM_OVERAGE',
  'STRIPE_PRICE_FOUNDERS_OVERAGE',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Default fixtures: one env overage ID and one env base ID.
  process.env.STRIPE_PRICE_STANDARD_OVERAGE = 'price_env_overage';
  process.env.STRIPE_PRICE_STANDARD = 'price_base';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

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
  itemMetadata,
}: {
  id: string;
  priceId: string;
  unit_amount?: number;
  lookup_key?: string;
  nickname?: string;
  metadata?: Record<string, string>;
  itemMetadata?: Record<string, string>;
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
    metadata: itemMetadata ?? {},
    subscription: 'sub_test',
  } as unknown as Stripe.SubscriptionItem;
}

const OPTS = { storedOveragePriceCents: 2500 };

function resolvedItem(items: Stripe.SubscriptionItem[], opts = OPTS) {
  const res = resolveOverageItem(items, opts);
  return res.kind === 'none' ? undefined : res.item;
}

// ---------------------------------------------------------------------------
// Matching heuristics (selection semantics)
// ---------------------------------------------------------------------------

describe('resolveOverageItem — selection', () => {
  it('matches by env overage price ID', () => {
    const item = makeItem({ id: 'si_1', priceId: 'price_env_overage' });
    expect(resolvedItem([item])).toBe(item);
  });

  it('resolves none when price ID is not in the env overage set and nothing else matches', () => {
    const item = makeItem({ id: 'si_1', priceId: 'price_unrelated' });
    expect(resolveOverageItem([item], { storedOveragePriceCents: 0 })).toEqual({ kind: 'none' });
  });

  it('matches by lookup_key containing "overage"', () => {
    const item = makeItem({ id: 'si_1', priceId: 'price_x', lookup_key: 'location overage' });
    expect(resolvedItem([item])).toBe(item);
  });

  it('matches by nickname containing "additional"', () => {
    const item = makeItem({ id: 'si_1', priceId: 'price_x', nickname: 'additional locations' });
    expect(resolvedItem([item])).toBe(item);
  });

  it('matches by price metadata.billing_role containing "extra"', () => {
    const item = makeItem({ id: 'si_1', priceId: 'price_x', metadata: { billing_role: 'extra location' } });
    expect(resolvedItem([item])).toBe(item);
  });

  it('matches by price metadata.role containing "add-on"', () => {
    const item = makeItem({ id: 'si_1', priceId: 'price_x', metadata: { role: 'location add-on' } });
    expect(resolvedItem([item])).toBe(item);
  });

  it('matches by nickname containing "addon" (no hyphen variant)', () => {
    const item = makeItem({ id: 'si_1', priceId: 'price_x', nickname: 'location addon' });
    expect(resolvedItem([item])).toBe(item);
  });

  it('matches by unit_amount when more than one item is present', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_other', unit_amount: 4900 });
    const overage = makeItem({ id: 'si_over', priceId: 'price_legacy', unit_amount: 2500 });
    expect(resolvedItem([base, overage])).toBe(overage);
  });

  it('does NOT match by unit_amount for a single-item subscription', () => {
    const only = makeItem({ id: 'si_only', priceId: 'price_legacy', unit_amount: 2500 });
    expect(resolveOverageItem([only], OPTS)).toEqual({ kind: 'none' });
  });

  it('never selects the base item even when its unit_amount collides with stored overage cents', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 2500 });
    expect(resolveOverageItem([base], OPTS)).toEqual({ kind: 'none' });
  });

  it('excludes base item by ID even in a multi-item subscription with unit_amount collision', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 2500 });
    const other = makeItem({ id: 'si_other', priceId: 'price_other', unit_amount: 9900 });
    expect(resolveOverageItem([base, other], OPTS)).toEqual({ kind: 'none' });
  });

  it('excludes a base item even when its descriptor matches an overage keyword', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', nickname: 'standard plan with extra perks' });
    expect(resolveOverageItem([base], OPTS)).toEqual({ kind: 'none' });
  });

  it('returns the real overage item when a base item with an overage keyword coexists with it', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', nickname: 'plan with extra perks' });
    const overage = makeItem({ id: 'si_over', priceId: 'price_env_overage' });
    expect(resolvedItem([base, overage])).toBe(overage);
  });

  it('resolves none for an empty item list', () => {
    expect(resolveOverageItem([], OPTS)).toEqual({ kind: 'none' });
  });

  it('resolves none when no item matches any heuristic', () => {
    const a = makeItem({ id: 'si_a', priceId: 'price_a', unit_amount: 1100, nickname: 'support' });
    const b = makeItem({ id: 'si_b', priceId: 'price_b', unit_amount: 9900 });
    expect(resolveOverageItem([a, b], OPTS)).toEqual({ kind: 'none' });
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

describe('resolveOverageItem — priority', () => {
  it('prefers env-ID match over keyword match', () => {
    const byKeyword = makeItem({ id: 'si_kw', priceId: 'price_kw', lookup_key: 'extra seat' });
    const byEnvId = makeItem({ id: 'si_env', priceId: 'price_env_overage' });
    expect(resolvedItem([byKeyword, byEnvId])).toBe(byEnvId);
  });

  it('prefers env-ID match over unit-amount match', () => {
    const byUnitAmount = makeItem({ id: 'si_unit', priceId: 'price_unit', unit_amount: 2500 });
    const byEnvId = makeItem({ id: 'si_env', priceId: 'price_env_overage', unit_amount: 9900 });
    expect(resolvedItem([byUnitAmount, byEnvId])).toBe(byEnvId);
  });

  it('prefers unit-amount match (trusted) over keyword match (untrusted)', () => {
    const byUnitAmount = makeItem({ id: 'si_unit', priceId: 'price_unit', unit_amount: 2500 });
    // Space-separated keyword so \b word boundaries fire correctly.
    const byKeyword = makeItem({ id: 'si_kw', priceId: 'price_kw', lookup_key: 'extra seat', unit_amount: 9900 });
    // The stored-cents match is the account's own grandfathered snapshot — a
    // strictly stronger signal than a nickname keyword. Mutating callers rely
    // on this ordering: untrusted matches are refused for writes.
    expect(resolvedItem([byUnitAmount, byKeyword])).toBe(byUnitAmount);
  });
});

// ---------------------------------------------------------------------------
// Confidence kinds — the contract mutating callers depend on
// ---------------------------------------------------------------------------

describe('resolveOverageItem — confidence kinds', () => {
  it('labels an env price-ID match trusted (price_id)', () => {
    const item = makeItem({ id: 'si_env', priceId: 'price_env_overage', unit_amount: 9900 });
    expect(resolveOverageItem([item], OPTS)).toEqual({ kind: 'trusted', item, matchedBy: 'price_id' });
  });

  it('labels an item-metadata billing_role=overage match trusted (metadata_role)', () => {
    const stamped = makeItem({
      id: 'si_meta',
      priceId: 'price_x',
      unit_amount: 9900,
      itemMetadata: { billing_role: OVERAGE_BILLING_ROLE },
    });
    const other = makeItem({ id: 'si_other', priceId: 'price_y' });
    expect(resolveOverageItem([stamped, other], OPTS)).toEqual({
      kind: 'trusted',
      item: stamped,
      matchedBy: 'metadata_role',
    });
  });

  it('labels a stored-cents match trusted (unit_amount)', () => {
    const legacy = makeItem({ id: 'si_legacy', priceId: 'price_old', unit_amount: 2500 });
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 4900 });
    expect(resolveOverageItem([base, legacy], OPTS)).toEqual({
      kind: 'trusted',
      item: legacy,
      matchedBy: 'unit_amount',
    });
  });

  it('labels a keyword-only match UNTRUSTED (descriptor) — mutating callers must refuse it', () => {
    const addOn = makeItem({ id: 'si_addon', priceId: 'price_addon', lookup_key: 'extra seat', unit_amount: 9900 });
    const other = makeItem({ id: 'si_other', priceId: 'price_other', unit_amount: 1100 });
    expect(resolveOverageItem([addOn, other], OPTS)).toEqual({
      kind: 'untrusted',
      item: addOn,
      matchedBy: 'descriptor',
    });
  });
});

// ---------------------------------------------------------------------------
// Mutation params builder
// ---------------------------------------------------------------------------

describe('overageItemMutationParams', () => {
  it('always carries the billing_role stamp and proration', () => {
    expect(overageItemMutationParams(3)).toEqual({
      quantity: 3,
      proration_behavior: 'create_prorations',
      metadata: { billing_role: OVERAGE_BILLING_ROLE },
    });
  });
});
