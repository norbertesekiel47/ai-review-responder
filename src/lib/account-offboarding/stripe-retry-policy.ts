// src/lib/account-offboarding/stripe-retry-policy.ts
//
// The offboarding lane's ONE Stripe retry policy: given a Stripe rejection, may
// the caller try again?
//
// WHY THIS FILE EXISTS, AND WHY IT IS SCOPED TO OFFBOARDING. The predicate was
// written twice, character for character, in `stripe-invoices.ts` and
// `stripe-customer-redaction.ts`. Both read the SAME vocabulary from the same
// two modules, so there was never a policy difference between them to preserve
// — only two copies of one rule, which `fallow` reported as a clone group and a
// complexity finding at the same time.
//
// IT DOES NOT LIVE IN `payments/stripe-error-inspect.ts`, and that is
// deliberate. That module's own docblock draws the line: it owns the
// VOCABULARY (which Stripe error types are retryable or permanent, which socket
// codes are transient) and states that "the consumers apply different RETRY
// POLICIES on top of these facts … and those policies are intentionally
// theirs". Moving a policy in there would erase the distinction the file is
// built around.
//
// IT MUST NOT ABSORB `worker/jobs/billing/stripe-overage-error.ts`. That
// classifier looks similar and is NOT the same rule: it treats a 409 in-flight
// idempotency conflict as TRANSIENT, where this policy treats every 4xx as
// permanent. The divergence is intentional and documented in `.fallowrc.jsonc`
// — billing mutations and offboarding destruction fail safely in opposite
// directions. Merging the two would introduce exactly the subtle bug that
// separation exists to prevent.
//
// So the rule is: one policy per lane, and this is the offboarding lane's.

import {
  RETRYABLE_STRIPE_ERROR_TYPES,
  PERMANENT_STRIPE_ERROR_TYPES,
} from '../payments/stripe-error-inspect';
import {
  RETRYABLE_NETWORK_ERROR_CODES,
  errorStringProperty,
  errorNumberProperty,
} from '../shared/error-inspect';

/**
 * True when an offboarding Stripe call may be retried.
 *
 * Ordered most-specific-first, because a Stripe SDK error carries several
 * signals and the narrower one is the more trustworthy:
 *
 *   1. `type` — the SDK's own classification, and the only signal that
 *      distinguishes a rate limit from an invalid request. Checked against both
 *      sets so an explicitly PERMANENT type short-circuits before the status
 *      code can re-open it.
 *   2. `statusCode` — 429 retries, 5xx retries, every other 4xx is permanent.
 *      **All idempotency errors are permanent here**, which is the half that
 *      differs from the billing worker's 409 rule.
 *   3. `code` — an OS socket code (`ECONNRESET` and friends) on a rejection
 *      that never reached Stripe at all, so it carries neither type nor status.
 *
 * Anything unrecognised is NOT retryable. That direction is the safe one for a
 * destructive lane: a wrong `false` surfaces a failure to an operator, while a
 * wrong `true` retries an irreversible provider call.
 */
export function isRetryableStripeError(err: unknown): boolean {
  const type = errorStringProperty(err, 'type');
  if (type && RETRYABLE_STRIPE_ERROR_TYPES.has(type)) return true;
  if (type && PERMANENT_STRIPE_ERROR_TYPES.has(type)) return false;

  const statusCode =
    errorNumberProperty(err, 'statusCode') ?? errorNumberProperty(err, 'status');
  if (statusCode === 429) return true;
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode <= 599) return true;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 499) return false;

  const code = errorStringProperty(err, 'code');
  return code ? RETRYABLE_NETWORK_ERROR_CODES.has(code) : false;
}
