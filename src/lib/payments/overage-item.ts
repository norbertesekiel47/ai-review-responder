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
// MATCH CONFIDENCE: read-only callers (drift detection) may act on any match,
// but MUTATING callers (delete / re-quantity / re-price) must only act on
// HIGH-confidence matches. A keyword in a nickname ("Priority Support Add-on")
// is enough to *flag* an item, never enough to *delete* one. Callers decide via
// `matchedBy`:
//   price_id      — item's price is in the env overage set        (high)
//   metadata_role — billing_role/role metadata is exactly 'overage' (high;
//                   stamped by this app on every item it creates)
//   unit_amount   — price equals the account's STORED overage cents (high;
//                   how legacy/rotated-price items are recognized)
//   descriptor    — keyword regex on lookup_key/nickname/metadata   (LOW —
//                   read-only tolerance; mutating callers must refuse)
//
// The algorithm intentionally runs base-exclusion FIRST, before any heuristic,
// so a base item whose unit_amount happens to equal storedOveragePriceCents can
// never be selected. The unit-amount fallback also uses the ORIGINAL items.length
// (not the candidate-set count) to preserve the existing poller semantics: a
// single-item subscription never matches by unit-amount alone.

import Stripe from 'stripe';

/** Metadata value this app stamps on every overage item it creates. */
export const OVERAGE_BILLING_ROLE = 'overage';

export type OverageMatchConfidence = 'price_id' | 'metadata_role' | 'unit_amount' | 'descriptor';

/** Confidences a MUTATING caller may act on. 'descriptor' is deliberately absent. */
export const MUTATION_SAFE_OVERAGE_MATCHES: ReadonlySet<OverageMatchConfidence> = new Set([
  'price_id',
  'metadata_role',
  'unit_amount',
]);

export interface OverageItemMatch {
  item: Stripe.SubscriptionItem;
  matchedBy: OverageMatchConfidence;
}

export interface FindOverageItemOptions {
  /** Price IDs sourced from the server environment (e.g. OVERAGE_PRICE_ID_*). */
  overagePriceIds: Set<string>;
  /** Price IDs for base subscription items. These are always excluded first. */
  basePriceIds: Set<string>;
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
 * Returns the overage line-item plus the confidence of the match, or
 * `undefined` if no item matches.
 *
 * Matching priority (candidates only — base items excluded first):
 *   1. Env price-ID match (overagePriceIds)
 *   2. Exact billing-role metadata match (item or price metadata === 'overage')
 *   3. Unit-amount match against the stored price — multi-item subscriptions only
 *   4. Keyword descriptor match (lookup_key / nickname / metadata) — LOW confidence
 */
export function findOverageItemMatch(
  items: Stripe.SubscriptionItem[],
  options: FindOverageItemOptions,
): OverageItemMatch | undefined {
  const { overagePriceIds, basePriceIds, storedOveragePriceCents } = options;

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
  if (byEnvId !== undefined) return { item: byEnvId, matchedBy: 'price_id' };

  // Priority 2 — exact billing-role metadata (stamped by this app on create)
  const byRole = candidates.find(hasOverageBillingRole);
  if (byRole !== undefined) return { item: byRole, matchedBy: 'metadata_role' };

  // Priority 3 — unit-amount match (multi-item subscriptions only). This is the
  // high-confidence path for legacy/rotated-price items: the stored cents are
  // the account's own grandfathered snapshot.
  if (originalCount > 1 && storedOveragePriceCents > 0) {
    const byUnitAmount = candidates.find(
      (item) => item.price?.unit_amount === storedOveragePriceCents,
    );
    if (byUnitAmount !== undefined) return { item: byUnitAmount, matchedBy: 'unit_amount' };
  }

  // Priority 4 — keyword descriptor match. LOW confidence: sufficient for
  // read-only drift detection, never for mutation.
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
  if (byKeyword !== undefined) return { item: byKeyword, matchedBy: 'descriptor' };

  return undefined;
}

/**
 * Convenience wrapper for callers that only need the item. Read-only callers
 * may use this directly; mutating callers must use findOverageItemMatch and
 * check `matchedBy` against MUTATION_SAFE_OVERAGE_MATCHES.
 */
export function findOverageItem(
  items: Stripe.SubscriptionItem[],
  options: FindOverageItemOptions,
): Stripe.SubscriptionItem | undefined {
  return findOverageItemMatch(items, options)?.item;
}
