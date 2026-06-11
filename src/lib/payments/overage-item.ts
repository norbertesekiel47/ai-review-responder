// src/lib/payments/overage-item.ts
//
// Single owner of the "which subscription item is the overage item?" predicate.
//
// WHY THIS EXISTS: Three callers previously held independent copies of this
// logic — the billing-reconciliation poller, the overage billing worker, and
// the tier-change route. Each could drift independently. When an overage Stripe
// Price is rotated, divergent implementations would cause a second overage item
// to be added instead of updating the existing one → double-billing. This module
// is the one authoritative representation; all callers must converge on it.
//
// The algorithm intentionally runs base-exclusion FIRST, before any heuristic,
// so a base item whose unit_amount happens to equal storedOveragePriceCents can
// never be selected. The unit-amount fallback also uses the ORIGINAL items.length
// (not the candidate-set count) to preserve the existing poller semantics: a
// single-item subscription never matches by unit-amount alone.

import Stripe from 'stripe';

export interface FindOverageItemOptions {
  /** Price IDs sourced from the server environment (e.g. OVERAGE_PRICE_ID_*). */
  overagePriceIds: Set<string>;
  /** Price IDs for base subscription items. These are always excluded first. */
  basePriceIds: Set<string>;
  /** Stored overage unit price in cents from the accounts row (point-in-time). */
  storedOveragePriceCents: number;
}

/**
 * Returns the first subscription item that is the overage line-item, or
 * `undefined` if no item matches.
 *
 * Matching priority (candidates only — base items excluded first):
 *   1. Env price-ID match (overagePriceIds)
 *   2. Keyword descriptor match (lookup_key / nickname / metadata.billing_role / metadata.role)
 *   3. Unit-amount match — only when the subscription has more than one item
 */
export function findOverageItem(
  items: Stripe.SubscriptionItem[],
  options: FindOverageItemOptions,
): Stripe.SubscriptionItem | undefined {
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
  if (byEnvId !== undefined) return byEnvId;

  // Priority 2 — keyword descriptor match
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
  if (byKeyword !== undefined) return byKeyword;

  // Priority 3 — unit-amount match (multi-item subscriptions only)
  if (originalCount > 1 && storedOveragePriceCents > 0) {
    return candidates.find(
      (item) => item.price?.unit_amount === storedOveragePriceCents,
    );
  }

  return undefined;
}
