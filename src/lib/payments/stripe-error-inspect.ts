// src/lib/payments/stripe-error-inspect.ts
//
// Single owner of the Stripe error-inspection vocabulary: the retryable /
// permanent error-type sets, the retryable network-error codes, and the
// defensive property readers used to inspect unknown thrown values.
//
// Two consumers apply different RETRY POLICIES on top of these facts —
// src/lib/account-offboarding/stripe-invoices.ts (boolean isRetryable, all
// idempotency errors permanent) and worker/jobs/billing/stripe-overage-error.ts
// (409 in-flight conflicts transient) — and those policies are intentionally
// theirs. What must never drift independently is the vocabulary below: a new
// Stripe SDK error type or retryable network code added for one consumer and
// not the other would make two billing paths retry differently for the same
// outage.

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

export const RETRYABLE_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

export function errorStringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : undefined;
}

export function errorNumberProperty(value: unknown, property: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'number' ? candidate : undefined;
}

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
