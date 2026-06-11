// worker/background/pollers/billing-reconciliation/stripe-overage.ts
//
// Pure Stripe-item helpers for billing reconciliation: classifying
// missing-subscription errors, filtering active subscriptions, and reading the
// customer id. No I/O — these operate on already-retrieved Stripe objects.
//
// The overage-item predicate is NOT defined here: it is owned by
// `@/lib/payments/overage-item` (resolveOverageItem) so the poller, the overage
// worker, and the tier-change route can never disagree and create a duplicate
// overage item.

import Stripe from 'stripe';

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
