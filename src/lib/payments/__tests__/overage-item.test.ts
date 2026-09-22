import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveOverageItem,
  resolveSubscriptionBilling,
  overageItemMutationParams,
  OVERAGE_BILLING_ROLE,
} from '../overage-item';

// ---------------------------------------------------------------------------
// Env stubs — the module reads the price-ID sets itself (call-time env, same
// semantics as price-tier-map). Tests stub env exactly as price-tier-map's
// own tests do.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'STRIPE_PRICE_COPILOT_LIST',
  'STRIPE_PRICE_COPILOT_FOUNDING',
  'STRIPE_PRICE_AUTOPILOT_LIST',
  'STRIPE_PRICE_AUTOPILOT_FOUNDING',
  'STRIPE_PRICE_COPILOT_OVERAGE',
  'STRIPE_PRICE_AUTOPILOT_OVERAGE',
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Default fixtures: one env overage ID and one env base ID.
  process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_env_overage';
  process.env.STRIPE_PRICE_COPILOT_LIST = 'price_base';
  process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_base_founding';
  process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot';
  process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
  process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_autopilot_overage';
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

// Default fixture account: stored overage cents DIFFER from stored base cents,
// so the unit-amount pass (Priority 3) stays enabled for every test that does
// not deliberately exercise the equal-amounts guard.
const OPTS = { storedOveragePriceCents: 2500, storedBasePriceCents: 7900 };

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
    expect(resolveOverageItem([item], { storedOveragePriceCents: 0, storedBasePriceCents: 7900 }))
      .toEqual({ kind: 'none' });
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
    const base = makeItem({ id: 'si_base', priceId: 'price_base', nickname: 'regular plan with extra perks' });
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
// #1298 — base/overage price collision after the 2026-09-14 reprice
// ---------------------------------------------------------------------------
//
// The list-variant reprice made the extra-location price EQUAL to the list base
// price (Copilot 7900/7900, Autopilot 14900/14900). Base-exclusion by Price ID
// is the only thing that kept the base item out of the unit-amount pass, and it
// holds only while every base Price ID is registered. A base Price ID that is
// NOT registered (a rotation that forgot RETAINED_STRIPE_PRICE_HISTORY, a
// misconfigured env, a hand-made Price) would otherwise match Priority 3 and be
// returned as `trusted` — which UpdateStripeOverageWorker may re-quantity,
// re-price or delete.
//
// The fix DOWNGRADES that match to `untrusted` rather than dropping it (a hybrid
// of the issue's options 1 and 3). Dropping it returns `{kind:'none'}`, which both
// mutating callers read as "no overage item exists" and answer by CREATING one —
// a duplicate overage line. `untrusted` makes them refuse instead. The two
// caller-level tests that pin that are in
// worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts and
// src/lib/accounts/__tests__/tier-change.test.ts.

describe('resolveOverageItem — equal stored base/overage cents (#1298)', () => {
  const LIST_COLLISION = { storedOveragePriceCents: 7900, storedBasePriceCents: 7900 };

  it('never returns an UNREGISTERED base item as trusted when stored base cents equal stored overage cents', () => {
    // price_base_rotated is NOT in the env base set, so base-exclusion cannot
    // remove it. Its unit_amount equals the stored overage cents, and `find`
    // reaches it before the real overage line — this is the #1298 defect.
    const unregisteredBase = makeItem({ id: 'si_base', priceId: 'price_base_rotated', unit_amount: 7900 });
    const legacyOverage = makeItem({ id: 'si_over', priceId: 'price_overage_rotated', unit_amount: 7900 });

    const res = resolveOverageItem([unregisteredBase, legacyOverage], LIST_COLLISION);

    expect(res.kind).not.toBe('trusted');
    // UNTRUSTED, not none: `none` means "no overage item exists" to every caller,
    // and both mutating callers answer that by creating a duplicate overage line.
    expect(res).toEqual({ kind: 'untrusted', item: unregisteredBase, matchedBy: 'unit_amount' });
  });

  it('keeps the descriptor pass reachable when no candidate carries the stored cents', () => {
    // Neither line sits at the colliding amount, so Priority 3 finds nothing and
    // the descriptor pass is what labels the real overage line — unchanged by the
    // guard, and still untrusted (flag-only) as it always was.
    const unregisteredBase = makeItem({ id: 'si_base', priceId: 'price_base_rotated', unit_amount: 6900 });
    const legacyOverage = makeItem({
      id: 'si_over',
      priceId: 'price_overage_rotated',
      unit_amount: 6900,
      nickname: 'additional location',
    });

    expect(resolveOverageItem([unregisteredBase, legacyOverage], LIST_COLLISION)).toEqual({
      kind: 'untrusted',
      item: legacyOverage,
      matchedBy: 'descriptor',
    });
  });

  it('still matches the stamped overage item by metadata_role when the amounts are equal (Priority 2 is unaffected)', () => {
    const unregisteredBase = makeItem({ id: 'si_base', priceId: 'price_base_rotated', unit_amount: 7900 });
    const stampedOverage = makeItem({
      id: 'si_over',
      priceId: 'price_overage_rotated',
      unit_amount: 7900,
      itemMetadata: { billing_role: OVERAGE_BILLING_ROLE },
    });

    expect(resolveOverageItem([unregisteredBase, stampedOverage], LIST_COLLISION)).toEqual({
      kind: 'trusted',
      item: stampedOverage,
      matchedBy: 'metadata_role',
    });
  });

  it('still matches the env overage Price ID when the amounts are equal (Priority 1 is unaffected)', () => {
    const unregisteredBase = makeItem({ id: 'si_base', priceId: 'price_base_rotated', unit_amount: 7900 });
    const overage = makeItem({ id: 'si_over', priceId: 'price_env_overage', unit_amount: 7900 });

    expect(resolveOverageItem([unregisteredBase, overage], LIST_COLLISION)).toEqual({
      kind: 'trusted',
      item: overage,
      matchedBy: 'price_id',
    });
  });

  it('keeps the unit-amount pass for a FOUNDING account, whose stored base cents differ from its stored overage cents', () => {
    // Founding Copilot: base 4900, extra location 7900 — no collision, so the
    // long-standing legacy/rotated-price recovery must still work.
    const founding = { storedOveragePriceCents: 7900, storedBasePriceCents: 4900 };
    const unregisteredBase = makeItem({ id: 'si_base', priceId: 'price_base_rotated', unit_amount: 4900 });
    const legacyOverage = makeItem({ id: 'si_over', priceId: 'price_overage_rotated', unit_amount: 7900 });

    expect(resolveOverageItem([unregisteredBase, legacyOverage], founding)).toEqual({
      kind: 'trusted',
      item: legacyOverage,
      matchedBy: 'unit_amount',
    });
  });

  it('keeps the unit-amount pass TRUSTED for a comped account whose stored base price is a real 0', () => {
    // accounts.base_price_cents is NOT NULL with a >= 0 check, so 0 is a stored
    // price (a comped/beta base line), not an "unknown" sentinel. 0 never equals
    // a positive stored overage price, so there is no collision to guard against.
    const compedBase = { storedOveragePriceCents: 7900, storedBasePriceCents: 0 };
    const other = makeItem({ id: 'si_other', priceId: 'price_other', unit_amount: 1100 });
    const legacyOverage = makeItem({ id: 'si_over', priceId: 'price_overage_rotated', unit_amount: 7900 });

    expect(resolveOverageItem([other, legacyOverage], compedBase)).toEqual({
      kind: 'trusted',
      item: legacyOverage,
      matchedBy: 'unit_amount',
    });
  });

  it('never reaches the unit-amount pass for a 0/0 account, so the equal-cents guard cannot fire there', () => {
    // A fully comped account (base 0, overage 0) is formally "equal", but the
    // pre-existing `storedOveragePriceCents > 0` gate rejects it first: a $0
    // overage line has no amount worth matching on. Pinned so the guard is never
    // credited (or blamed) for this case.
    const fullyComped = { storedOveragePriceCents: 0, storedBasePriceCents: 0 };
    const zeroA = makeItem({ id: 'si_a', priceId: 'price_a', unit_amount: 0 });
    const zeroB = makeItem({ id: 'si_b', priceId: 'price_b', unit_amount: 0 });

    expect(resolveOverageItem([zeroA, zeroB], fullyComped)).toEqual({ kind: 'none' });
  });

  it('applies the guard through resolveSubscriptionBilling, whose base item stays comparable for drift detection', () => {
    const unregisteredBase = makeItem({ id: 'si_base', priceId: 'price_base_rotated', unit_amount: 7900 });
    const legacyOverage = makeItem({ id: 'si_over', priceId: 'price_overage_rotated', unit_amount: 7900 });

    const res = resolveSubscriptionBilling([unregisteredBase, legacyOverage], LIST_COLLISION);

    expect(res.overage).toEqual({ kind: 'untrusted', item: unregisteredBase, matchedBy: 'unit_amount' });
    // Read-only drift detection accepts any confidence, so the poller still has a
    // line to compare unit_amounts against — here the remaining non-overage item,
    // carried by the INFERRED fallback because its price is not in the map.
    expect(res.base).toEqual({ item: legacyOverage, tier: null, inferred: true });
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
// resolveSubscriptionBilling — base resolution (positive + inferred fallback)
// ---------------------------------------------------------------------------
//
// Env stubs (beforeEach above): Copilot list maps `price_base` and the
// canonical Copilot overage maps `price_env_overage`.

describe('resolveSubscriptionBilling — base resolution', () => {
  it('resolves the base item POSITIVELY via the price-tier-map when the base price is known', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 7900 });
    const overage = makeItem({ id: 'si_over', priceId: 'price_env_overage', unit_amount: 2500 });
    const res = resolveSubscriptionBilling([base, overage], OPTS);
    expect(res.base).toEqual({ item: base, tier: 'copilot', variant: 'list' });
    expect(res.overage).toEqual({ kind: 'trusted', item: overage, matchedBy: 'price_id' });
  });

  it('falls back to an INFERRED base when the base price is legacy/rotated (not in the env map)', () => {
    // price_legacy_base is NOT a configured base price → tierForBasePriceId is null.
    const legacyBase = makeItem({ id: 'si_base', priceId: 'price_legacy_base', unit_amount: 6900 });
    const overage = makeItem({ id: 'si_over', priceId: 'price_env_overage', unit_amount: 2500 });
    const res = resolveSubscriptionBilling([legacyBase, overage], OPTS);
    // This is the load-bearing fallback the reconcile poller depends on: the base
    // item is still returned (so its unit_amount stays comparable for drift
    // detection), explicitly flagged tier:null/inferred so no caller mistakes it
    // for a positively-confirmed tier.
    expect(res.base).toEqual({ item: legacyBase, tier: null, inferred: true });
  });

  it('the inferred fallback is the first NON-overage item (overage is excluded even when it sorts first)', () => {
    const overage = makeItem({ id: 'si_over', priceId: 'price_env_overage', unit_amount: 2500 });
    const legacyBase = makeItem({ id: 'si_base', priceId: 'price_legacy_base', unit_amount: 6900 });
    const res = resolveSubscriptionBilling([overage, legacyBase], OPTS);
    expect(res.base?.item).toBe(legacyBase);
    expect(res.base).toMatchObject({ tier: null, inferred: true });
  });

  it('prefers the positively-mapped base over the inferred fallback in a multi-item subscription', () => {
    const legacyExtra = makeItem({ id: 'si_extra', priceId: 'price_unrelated', unit_amount: 1100 });
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 7900 });
    const overage = makeItem({ id: 'si_over', priceId: 'price_env_overage', unit_amount: 2500 });
    const res = resolveSubscriptionBilling([legacyExtra, base, overage], OPTS);
    expect(res.base).toEqual({ item: base, tier: 'copilot', variant: 'list' });
  });

  it('returns base:undefined when the only item is the overage item', () => {
    const overage = makeItem({ id: 'si_over', priceId: 'price_env_overage', unit_amount: 2500 });
    const res = resolveSubscriptionBilling([overage], OPTS);
    expect(res.base).toBeUndefined();
    expect(res.overage.kind).toBe('trusted');
  });

  it('returns base:undefined and overage none for an empty subscription', () => {
    const res = resolveSubscriptionBilling([], OPTS);
    expect(res.base).toBeUndefined();
    expect(res.overage).toEqual({ kind: 'none' });
  });

  it('delegates overage resolution to resolveOverageItem (same confidence-graded result)', () => {
    const base = makeItem({ id: 'si_base', priceId: 'price_base', unit_amount: 7900 });
    const keywordOverage = makeItem({ id: 'si_kw', priceId: 'price_kw', lookup_key: 'extra seat', unit_amount: 9900 });
    const res = resolveSubscriptionBilling([base, keywordOverage], OPTS);
    expect(res.overage).toEqual({ kind: 'untrusted', item: keywordOverage, matchedBy: 'descriptor' });
    expect(res.base).toEqual({ item: base, tier: 'copilot', variant: 'list' });
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
