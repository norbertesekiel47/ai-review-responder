import { describe, expect, it } from 'vitest';
import { isRetryableStripeError } from '../stripe-retry-policy';

// The offboarding lane's ONE Stripe retry policy, now that
// `stripe-invoices.ts` and `stripe-customer-redaction.ts` share it instead of
// each carrying a byte-identical copy.
//
// Both callers already assert their own OUTCOMES (which error message, which
// disposition). What neither asserted directly is the RULE itself — the copies
// were only reachable through a thrown provider error. This file pins the rule,
// which is what makes the extraction safe to keep: a future edit here fails
// loudly rather than silently changing two lanes at once.

function stripeErr(props: Record<string, unknown>): Error {
  return Object.assign(new Error('stripe'), props);
}

describe('isRetryableStripeError', () => {
  // ---- 1. type wins, and a permanent type short-circuits the status code ----

  it.each([
    'StripeAPIConnectionError',
    'StripeConnectionError',
    'StripeAPIError',
    'StripeRateLimitError',
  ])('retries the transport/availability type %s', (type) => {
    expect(isRetryableStripeError(stripeErr({ type }))).toBe(true);
  });

  it.each([
    'StripeInvalidRequestError',
    'StripeAuthenticationError',
    'StripePermissionError',
    'StripeIdempotencyError',
  ])('refuses the permanent type %s', (type) => {
    expect(isRetryableStripeError(stripeErr({ type }))).toBe(false);
  });

  it('lets a PERMANENT type beat a retryable-looking status code', () => {
    // Ordering matters: the SDK's own classification is the narrower signal.
    // Were the status checked first, a 500 carried on an invalid-request error
    // would retry a call that can never succeed.
    expect(
      isRetryableStripeError(stripeErr({ type: 'StripeInvalidRequestError', statusCode: 500 })),
    ).toBe(false);
  });

  it('lets a RETRYABLE type beat a permanent-looking status code', () => {
    expect(
      isRetryableStripeError(stripeErr({ type: 'StripeRateLimitError', statusCode: 400 })),
    ).toBe(true);
  });

  // ---- 2. status codes, when the type says nothing -------------------------

  it('retries 429', () => {
    expect(isRetryableStripeError(stripeErr({ statusCode: 429 }))).toBe(true);
  });

  it.each([500, 502, 503, 599])('retries server error %i', (statusCode) => {
    expect(isRetryableStripeError(stripeErr({ statusCode }))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422, 499])('refuses client error %i', (statusCode) => {
    expect(isRetryableStripeError(stripeErr({ statusCode }))).toBe(false);
  });

  it('reads `status` when `statusCode` is absent', () => {
    expect(isRetryableStripeError(stripeErr({ status: 503 }))).toBe(true);
    expect(isRetryableStripeError(stripeErr({ status: 400 }))).toBe(false);
  });

  it('treats 409 as PERMANENT — the line that separates this lane from billing', () => {
    // worker/jobs/billing/stripe-overage-error.ts treats an in-flight
    // idempotency conflict as TRANSIENT. That divergence is deliberate and
    // documented in .fallowrc.jsonc, so this assertion is the guard against
    // anyone "unifying" the two classifiers later.
    expect(isRetryableStripeError(stripeErr({ statusCode: 409 }))).toBe(false);
  });

  // ---- 3. socket codes, for a rejection that never reached Stripe ----------

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'])(
    'retries the socket code %s carried alone',
    (code) => {
      expect(isRetryableStripeError(stripeErr({ code }))).toBe(true);
    },
  );

  it('ignores a socket code once a status code has already decided', () => {
    expect(isRetryableStripeError(stripeErr({ statusCode: 400, code: 'ECONNRESET' }))).toBe(false);
  });

  // ---- 4. the safe default ------------------------------------------------

  it.each([
    ['an empty object', {}],
    ['an unknown type', { type: 'StripeSomethingNew' }],
    ['an unknown code', { code: 'ENOTAREALCODE' }],
  ])('refuses %s — unrecognised is never retryable', (_label, props) => {
    expect(isRetryableStripeError(stripeErr(props))).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
    ['a number', 500],
  ])('refuses %s rather than throwing', (_label, value) => {
    expect(isRetryableStripeError(value)).toBe(false);
  });
});
