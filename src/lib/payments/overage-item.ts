// src/lib/payments/overage-item.ts
//
// Single owner of the "which subscription item is the overage item?" predicate.
//
// WHY THIS EXISTS: callers previously held independent copies of this logic —
// the billing-reconciliation poller, the overage billing worker, and the
// tier-change route. Each could drift independently. When an overage Stripe
// Price is rotated, divergent implementations would cause a second overage item
// to be added instead of updating the existing one → double-billing. This module
// is the one authoritative representation; all callers must converge on it.
//
// The env-derived price-ID sets are read HERE (from price-tier-map, at call
// time — same env semantics as that module), not passed in by callers: the sets
// are not caller knowledge, and a caller passing a wrong/empty set would
// silently degrade matching. The only per-account input is the stored cents.
//
// MATCH CONFIDENCE is encoded in the result kind, so the type system forces
// every consumer to decide what 'untrusted' means for it:
//   trusted   — price_id (env overage set), metadata_role (billing_role stamp,
//               written by this app on every item it creates), or unit_amount
//               (equals the account's STORED grandfathered cents). Safe to
//               mutate (delete / re-quantity / re-price).
//   untrusted — descriptor keyword (lookup_key/nickname/metadata regex), or a
//               unit-amount match the stored cents can no longer disambiguate
//               (see the #1298 paragraph). Enough to FLAG an item for read-only
//               drift detection, never enough to mutate one ("Priority Support
//               Add-on" keyword-matches). A mutating caller turns `untrusted`
//               into a refusal — NOT into "no overage item exists", which is
//               what makes the downgrade safe; see the #1298 paragraph.
//
// The algorithm runs base-exclusion FIRST, before any heuristic, so a REGISTERED
// base item (env base Price ID or retained base-price history) can never be
// selected. That exclusion is by Price ID, so it protects nothing when a base
// Price ID is unregistered — a rotation that forgot RETAINED_STRIPE_PRICE_HISTORY,
// a misconfigured env, or a Price created by hand. Since the 2026-09-14 list
// reprice (#1290) the extra-location price EQUALS the list base price on both
// tiers (Copilot 7900/7900, Autopilot 14900/14900), so on a list-variant account
// such an unregistered base item would match the unit-amount pass and be handed
// back as `trusted` for a caller to re-quantity, re-price or delete. The guard is
// the account's own stored cents: when storedOveragePriceCents equals
// storedBasePriceCents the unit-amount pass CANNOT tell the two lines apart, so
// its match is DOWNGRADED to `untrusted` (#1298) — flagged, never mutated.
//
// The downgrade, not a skip. #1298 listed three options; this is a hybrid of its
// option 1 (feed the stored base cents in) and its option 3 (an ambiguous
// unit-amount match is untrusted, never mutated). Dropping the pass outright —
// option 1 alone — was tried and rejected: it returns `{kind:'none'}`, and no
// caller reads that as "ambiguous". `syncStripeOverageItem` reads it as "no
// overage item exists" and creates one (`worker/jobs/billing/overage-sync.ts`,
// whose idempotency key dedupes retries, not a pre-existing second line), and
// `planOverageMutation` in `src/lib/accounts/tier-change.ts` does the same. That
// is a duplicate overage item — the double-billing this module was written to
// prevent. `untrusted` instead makes both mutating callers REFUSE and hand the
// account to ops, while read-only drift detection still sees the item.
//
// ACCEPTED COST: the downgrade fires on stored-cents equality alone. It does not
// check whether a base item actually survived base-exclusion, because the module
// has no signal that would tell it — an unregistered base Price ID is invisible
// by construction. So a list-variant account whose base Price ID IS registered
// (the common case, where base-exclusion already removed every base item) still
// loses the trusted unit-amount pass. The price is paid by the accounts that
// reach Priority 3 at all, which is only those whose overage item is BOTH
// unregistered AND unstamped.
//
// Priorities 1 and 2 are unaffected: an env Price-ID match and the `billing_role`
// stamp this app writes on every overage item it creates or re-prices both still
// resolve trusted under the collision, and the stamp is the primary defense the
// narrow unit-amount pass was always deferring to.
// The unit-amount pass uses the ORIGINAL items.length (not the candidate-set
// count) to preserve the long-standing poller semantics: a single-item
// subscription never matches by unit-amount alone.

import Stripe from 'stripe';
import type {
  PriceVariant,
  SubscriptionTierValue,
} from '@/lib/accounts/tier-config';
import {
  basePriceIdSet,
  basePriceInfoForId,
  overagePriceIdSet,
} from './price-tier-map';

/** Metadata value this app stamps on every overage item it creates or re-prices. */
export const OVERAGE_BILLING_ROLE = 'overage';

export type TrustedOverageMatch = 'price_id' | 'metadata_role' | 'unit_amount';

export type OverageItemResolution =
  | { kind: 'none' }
  | { kind: 'trusted'; item: Stripe.SubscriptionItem; matchedBy: TrustedOverageMatch }
  | { kind: 'untrusted'; item: Stripe.SubscriptionItem; matchedBy: 'descriptor' | 'unit_amount' };

export interface ResolveOverageItemOptions {
  /** Stored overage unit price in cents from the accounts row (point-in-time). */
  storedOveragePriceCents: number;
  /**
   * Stored BASE unit price in cents from the same accounts row (point-in-time).
   * Required, not optional: it is the only input that tells the unit-amount pass
   * whether a stored-cents match can still distinguish the overage line from the
   * base line, and a caller that omitted it would silently get the pre-#1298
   * behaviour back.
   *
   * `accounts.base_price_cents` is NOT NULL with a `>= 0` check, so 0 is a real
   * stored price (a comped/beta account billed nothing for its base line), not an
   * "unknown" sentinel. It needs no special case either way: a comped account with
   * a positive overage price is unequal, so the pass stays trusted; a 0/0 account
   * never reaches the pass at all, because `storedOveragePriceCents > 0` gates it
   * first and a $0 overage line has no amount worth matching on.
   */
  storedBasePriceCents: number;
}

function hasOverageBillingRole(item: Stripe.SubscriptionItem): boolean {
  return (
    item.metadata?.['billing_role'] === OVERAGE_BILLING_ROLE ||
    item.price?.metadata?.['billing_role'] === OVERAGE_BILLING_ROLE ||
    item.price?.metadata?.['role'] === OVERAGE_BILLING_ROLE
  );
}

/**
 * Resolves the overage line-item for a subscription.
 *
 * Matching priority (candidates only — base items excluded first):
 *   1. Env price-ID match                          → trusted (price_id)
 *   2. Exact billing-role metadata match           → trusted (metadata_role)
 *   3. Unit-amount vs stored cents (multi-item)    → trusted (unit_amount) when
 *                                                    the stored overage cents
 *                                                    differ from the stored base
 *                                                    cents, else untrusted
 *                                                    (unit_amount) — #1298
 *   4. Keyword descriptor match                    → untrusted (descriptor)
 */
export function resolveOverageItem(
  items: Stripe.SubscriptionItem[],
  options: ResolveOverageItemOptions,
): OverageItemResolution {
  const { storedOveragePriceCents, storedBasePriceCents } = options;
  const overagePriceIds = overagePriceIdSet();
  const basePriceIds = basePriceIdSet();

  // Keep the original count so the unit-amount guard uses the real subscription
  // size, not the candidate count.
  const originalCount = items.length;

  const candidates = items.filter((item) => {
    const priceId = item.price?.id;
    if (priceId && basePriceIds.has(priceId)) return false;
    return true;
  });

  // Priority 1 — env price-ID match
  const byEnvId = candidates.find(
    (item) => item.price?.id != null && overagePriceIds.has(item.price.id),
  );
  if (byEnvId !== undefined) return { kind: 'trusted', item: byEnvId, matchedBy: 'price_id' };

  // Priority 2 — exact billing-role metadata (stamped by this app)
  const byRole = candidates.find(hasOverageBillingRole);
  if (byRole !== undefined) return { kind: 'trusted', item: byRole, matchedBy: 'metadata_role' };

  // Priority 3 — unit-amount match (multi-item subscriptions only). The
  // high-confidence path for legacy/rotated-price items: the stored cents are
  // the account's own grandfathered snapshot. OVERAGE-F3: the `originalCount > 1`
  // guard means a solo-location sub whose ONLY line is the overage item can't
  // match here — by design. The `billing_role` metadata stamp (Priority 2) is the
  // primary defense for that case; this unit-amount pass is intentionally narrow.
  //
  // #1298: the stored cents stop being a discriminator the moment the account's
  // stored overage price equals its stored base price (every list-variant account
  // since the 2026-09-14 reprice). Base-exclusion above is by Price ID only, so an
  // unregistered base item survives into `candidates` and would match this pass —
  // and `find` returns the base line first. DOWNGRADE the match to `untrusted`
  // rather than trusting it: a mutating caller then refuses the account instead of
  // re-quantitying the customer's base line. Do NOT turn this into a skip —
  // `{kind:'none'}` means "no overage item exists" to every caller, and both
  // mutating callers answer that by CREATING one. See the header's #1298 paragraph.
  const storedCentsDiscriminate = storedOveragePriceCents !== storedBasePriceCents;
  if (originalCount > 1 && storedOveragePriceCents > 0) {
    const byUnitAmount = candidates.find(
      (item) => item.price?.unit_amount === storedOveragePriceCents,
    );
    if (byUnitAmount !== undefined) {
      return storedCentsDiscriminate
        ? { kind: 'trusted', item: byUnitAmount, matchedBy: 'unit_amount' }
        : { kind: 'untrusted', item: byUnitAmount, matchedBy: 'unit_amount' };
    }
  }

  // Priority 4 — keyword descriptor match. Read-only tolerance, never mutation.
  const byKeyword = candidates.find((item) => {
    const price = item.price;
    if (!price) return false;
    const descriptor = [
      price.lookup_key,
      price.nickname,
      price.metadata?.['billing_role'],
      price.metadata?.['role'],
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return /\b(overage|additional|extra|add-on|addon)\b/.test(descriptor);
  });
  if (byKeyword !== undefined) return { kind: 'untrusted', item: byKeyword, matchedBy: 'descriptor' };

  return { kind: 'none' };
}

/**
 * The base subscription line item, with its tier resolved POSITIVELY from the
 * price-tier-map when the base price is known.
 *
 *   { item, tier }                      — base price maps to a tier (authoritative).
 *   { item, tier: null, inferred: true } — base price is unknown (legacy, rotated,
 *                                          or grandfathered out of the env map). The
 *                                          item is still the base line (first
 *                                          non-overage item), so its unit_amount
 *                                          stays comparable for drift detection, but
 *                                          `tier` is NOT trustworthy — a caller that
 *                                          needs an authoritative tier must refuse it.
 */
export type BaseItemResolution =
  | {
      item: Stripe.SubscriptionItem;
      tier: SubscriptionTierValue;
      variant: PriceVariant;
    }
  | { item: Stripe.SubscriptionItem; tier: null; inferred: true };

export interface SubscriptionBillingResolution {
  /** The base line item, or undefined when the subscription has no non-overage item. */
  base: BaseItemResolution | undefined;
  /** The overage line item, confidence-graded — see resolveOverageItem. */
  overage: OverageItemResolution;
}

/**
 * Resolves BOTH billing line items of a subscription in one pass: the overage
 * item (delegated to resolveOverageItem — the single owner of that predicate)
 * and the base item.
 *
 * Base resolution is positive-first:
 *   1. The first non-overage item whose price maps to a tier via the
 *      price-tier-map is the base, and its tier is returned.
 *   2. INFERRED FALLBACK — when no item maps (a legacy/rotated/grandfathered base
 *      price), the FIRST non-overage item is returned as
 *      { tier: null, inferred: true }.
 *
 * The inferred fallback is intentional and load-bearing: the billing-reconciliation
 * poller MUST still flag a `price_mismatch` for a base price that has rotated out of
 * the env map. Positive-only resolution would return no base item there and silently
 * swallow that drift — the very signal the poller exists to raise. The `inferred`
 * flag documents, in the type, that the base price could not be positively confirmed,
 * so callers needing an authoritative tier can refuse it while drift detection that
 * only compares the stored unit-amount can still proceed.
 */
export function resolveSubscriptionBilling(
  items: Stripe.SubscriptionItem[],
  options: ResolveOverageItemOptions,
): SubscriptionBillingResolution {
  const overage = resolveOverageItem(items, options);
  const overageItemId = overage.kind === 'none' ? undefined : overage.item.id;
  const nonOverageItems = items.filter((item) => item.id !== overageItemId);

  // Priority 1 — positive tier resolution via the price-tier-map.
  for (const item of nonOverageItems) {
    const priceId = item.price?.id;
    const info = basePriceInfoForId(priceId);
    if (info !== null) {
      return {
        base: {
          item,
          tier: info.tier,
          variant: info.variant,
        },
        overage,
      };
    }
  }

  // Priority 2 — inferred fallback: the first non-overage item. Byte-equivalent
  // to the poller's historical `find(item => item.id !== overageItem?.id)`.
  const inferredBase = nonOverageItems[0];
  if (inferredBase !== undefined) {
    return { base: { item: inferredBase, tier: null, inferred: true }, overage };
  }

  return { base: undefined, overage };
}

/**
 * Shared Stripe params for mutating an overage item. Owning the billing_role
 * stamp here makes it structurally impossible for a caller to create or
 * re-price an overage item without the stamp — the stamp is what makes the
 * item exactly matchable after any future price rotation, and it migrates
 * legacy (pre-stamp) items to the authoritative marker on their next touch.
 */
export function overageItemMutationParams(quantity: number): {
  quantity: number;
  proration_behavior: 'create_prorations';
  metadata: { billing_role: string };
} {
  return {
    quantity,
    proration_behavior: 'create_prorations',
    metadata: { billing_role: OVERAGE_BILLING_ROLE },
  };
}
