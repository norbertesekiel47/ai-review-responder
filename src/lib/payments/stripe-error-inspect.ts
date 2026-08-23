// src/lib/payments/stripe-error-inspect.ts
//
// Single owner of the STRIPE error-inspection vocabulary: the retryable /
// permanent error-type sets and the coupon-fault classifier. The
// provider-agnostic half — the retryable OS-socket codes and the defensive
// property readers — moved to src/lib/shared/error-inspect.ts (#913) when its
// third non-Stripe consumer arrived; import them from there.
//
// The consumers apply different RETRY POLICIES on top of these facts —
// src/lib/account-offboarding/stripe-invoices.ts (boolean isRetryable, all
// idempotency errors permanent) and worker/jobs/billing/stripe-overage-error.ts
// (409 in-flight conflicts transient) — and those policies are intentionally
// theirs. What must never drift independently is the vocabulary below: a new
// Stripe SDK error type added for one consumer and not the other would make
// two billing paths retry differently for the same outage.

import { errorStringProperty } from '@/lib/shared/error-inspect';

export const RETRYABLE_STRIPE_ERROR_TYPES: ReadonlySet<string> = new Set([
  'StripeAPIConnectionError',
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
]);

export const PERMANENT_STRIPE_ERROR_TYPES: ReadonlySet<string> = new Set([
  'StripeInvalidRequestError',
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeIdempotencyError',
]);

/**
 * True when a Stripe rejection was caused by the SESSION'S COUPON rather than
 * by anything else about the request (admin-invite-funnel plan step 11c).
 *
 * A bad `BETA_COMP_COUPON_ID` — a test-mode id deployed to live mode, a deleted
 * or expired coupon, a typo — is a configuration fault an operator must fix,
 * and it is indistinguishable from any other 400 unless the coupon signal is
 * read out. This predicate is a CLASSIFIER only; the retry policy stays with
 * each consumer, exactly like the type sets above (a coupon error is a
 * `StripeInvalidRequestError` and therefore already PERMANENT — retrying it
 * would just fail identically).
 *
 * Ordered strongest-signal-first:
 *   1. `param` — Stripe names the offending field (`discounts[0][coupon]`),
 *      which is unambiguous and stable.
 *   2. `code` — `coupon_expired` is a coupon fault whose `param` may be absent.
 *   3. `message` — last-resort substring, and only after the type check has
 *      already narrowed to an invalid-request error. Kept because a missing
 *      coupon can arrive as `resource_missing` ("No such coupon: …"), a code
 *      shared with every other missing resource; matching the code alone would
 *      misfile a missing PRICE as a coupon problem.
 */
export function isStripeCouponError(value: unknown): boolean {
  if (errorStringProperty(value, 'type') !== 'StripeInvalidRequestError') {
    return false;
  }
  const param = errorStringProperty(value, 'param');
  if (param?.toLowerCase().includes('coupon')) return true;
  if (errorStringProperty(value, 'code') === 'coupon_expired') return true;
  const message = errorStringProperty(value, 'message');
  return message !== undefined && /coupon/i.test(message);
}
