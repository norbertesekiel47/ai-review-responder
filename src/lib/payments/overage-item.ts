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
//   untrusted — descriptor keyword only (lookup_key/nickname/metadata regex).
//               Enough to FLAG an item for read-only drift detection, never
//               enough to mutate one ("Priority Support Add-on" keyword-matches).
//
// The algorithm intentionally runs base-exclusion FIRST, before any heuristic,
// so a base item whose unit_amount happens to equal storedOveragePriceCents can
// never be selected. The unit-amount pass uses the ORIGINAL items.length
// (not the candidate-set count) to preserve the long-standing poller semantics:
// a single-item subscription never matches by unit-amount alone.

import Stripe from 'stripe';
import { basePriceIdSet, overagePriceIdSet } from './price-tier-map';

/** Metadata value this app stamps on every overage item it creates or re-prices. */
export const OVERAGE_BILLING_ROLE = 'overage';

export type TrustedOverageMatch = 'price_id' | 'metadata_role' | 'unit_amount';

export type OverageItemResolution =
  | { kind: 'none' }
  | { kind: 'trusted'; item: Stripe.SubscriptionItem; matchedBy: TrustedOverageMatch }
  | { kind: 'untrusted'; item: Stripe.SubscriptionItem; matchedBy: 'descriptor' };

export interface ResolveOverageItemOptions {
  /** Stored overage unit price in cents from the accounts row (point-in-time). */
  storedOveragePriceCents: number;
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
 *   3. Unit-amount vs stored cents (multi-item)    → trusted (unit_amount)
 *   4. Keyword descriptor match                    → untrusted (descriptor)
 */
export function resolveOverageItem(
  items: Stripe.SubscriptionItem[],
  options: ResolveOverageItemOptions,
): OverageItemResolution {
  const { storedOveragePriceCents } = options;
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
  if (originalCount > 1 && storedOveragePriceCents > 0) {
    const byUnitAmount = candidates.find(
      (item) => item.price?.unit_amount === storedOveragePriceCents,
    );
    if (byUnitAmount !== undefined) {
      return { kind: 'trusted', item: byUnitAmount, matchedBy: 'unit_amount' };
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
