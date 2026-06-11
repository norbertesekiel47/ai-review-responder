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
