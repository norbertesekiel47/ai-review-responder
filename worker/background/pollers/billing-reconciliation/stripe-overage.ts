// worker/background/pollers/billing-reconciliation/stripe-overage.ts
//
// Pure Stripe-item helpers for billing reconciliation: identifying the overage
// subscription item, classifying missing-subscription errors, filtering active
// subscriptions, and reading the customer id. No I/O — these operate on
// already-retrieved Stripe objects and environment-configured price IDs.

import Stripe from 'stripe';

// Overage price IDs — used to identify the overage subscription item
export function getOveragePriceIds(): Set<string> {
  return new Set([
    process.env.STRIPE_PRICE_STANDARD_OVERAGE ?? '',
    process.env.STRIPE_PRICE_PREMIUM_OVERAGE ?? '',
    process.env.STRIPE_PRICE_FOUNDERS_OVERAGE ?? '',
  ].filter(Boolean));
}

export function extractStripeCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
): string | null {
  if (typeof customer === 'string') return customer;
  return customer?.id ?? null;
}

export function isMissingStripeSubscriptionError(err: unknown): boolean {
  const maybeStripeError = err as {
    code?: string;
    statusCode?: number;
    type?: string;
    message?: string;
  } | null;
  if (!maybeStripeError) return false;

  return maybeStripeError.code === 'resource_missing'
    || maybeStripeError.statusCode === 404
    || maybeStripeError.type === 'StripeInvalidRequestError'
      && /no such subscription/i.test(maybeStripeError.message ?? '');
}

export function activeStripeSubscriptions(
  subscriptions: Stripe.ApiList<Stripe.Subscription> | { data?: Stripe.Subscription[] },
): Stripe.Subscription[] {
  const data = subscriptions.data ?? [];
  return data.filter((subscription) =>
    ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status),
  );
}

export function findOverageItem(
  subscription: Stripe.Subscription,
  overagePriceIds: Set<string>,
  expectedOverageUnitPriceCents: number,
): Stripe.SubscriptionItem | undefined {
  const items = subscription.items?.data ?? [];
  return items.find((item) =>
    isOverageItem(item, overagePriceIds, expectedOverageUnitPriceCents, items.length),
  );
}

export function isOverageItem(
  item: Stripe.SubscriptionItem,
  overagePriceIds: Set<string>,
  expectedOverageUnitPriceCents: number,
  itemCount: number,
): boolean {
  const price = item.price;
  if (!price) return false;
  if (price.id && overagePriceIds.has(price.id)) return true;

  const priceDescriptor = [
    price.lookup_key,
    price.nickname,
    price.metadata?.billing_role,
    price.metadata?.role,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(overage|additional|extra|add-on|addon)\b/.test(priceDescriptor)) {
    return true;
  }

  return itemCount > 1
    && expectedOverageUnitPriceCents > 0
    && price.unit_amount === expectedOverageUnitPriceCents;
}
