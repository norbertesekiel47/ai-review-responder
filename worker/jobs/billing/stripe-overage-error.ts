// worker/jobs/billing/stripe-overage-error.ts
//
// Transient/terminal RETRY POLICY for UpdateStripeOverageWorker's Stripe calls.
//
// The error-inspection vocabulary (type sets, network codes, property readers)
// is owned by src/lib/payments/stripe-error-inspect.ts and shared with the
// offboarding classifier. This module owns only the policy delta: a 409
// in-flight idempotency conflict is TRANSIENT here (a concurrent same-key
// request is still processing — retry resolves it), while the offboarding
// policy treats all idempotency errors as permanent.
//
// Semantics:
//   transient → leave the outbox row 'dispatched'; BullMQ retries and the 1h
//               outbox watchdog re-dispatches. Do NOT markOutboxFailed.
//   terminal  → deterministic failure that never heals; markOutboxFailed and
//               throw UnrecoverableError so BullMQ does not retry.

import {
  RETRYABLE_STRIPE_ERROR_TYPES,
  PERMANENT_STRIPE_ERROR_TYPES,
  RETRYABLE_NETWORK_ERROR_CODES,
  errorStringProperty,
  errorNumberProperty,
} from '../../../src/lib/payments/stripe-error-inspect';

type StripeOverageErrorClass = 'transient' | 'terminal';

export function classifyStripeOverageError(err: unknown): StripeOverageErrorClass {
  const type = errorStringProperty(err, 'type');
  const statusCode = errorNumberProperty(err, 'statusCode') ?? errorNumberProperty(err, 'status');
  const code = errorStringProperty(err, 'code');

  // Key reuse with DIFFERENT params: deterministic, never heals on retry.
  if (statusCode === 400 && code === 'idempotency_error') return 'terminal';

  // In-flight idempotency conflict: a concurrent request with the SAME key is
  // still processing. Retry. Must come BEFORE the type/4xx terminal rules so a
  // 409 StripeIdempotencyError / StripeInvalidRequestError doesn't fall through
  // to terminal.
  if (statusCode === 409) return 'transient';

  if (type && RETRYABLE_STRIPE_ERROR_TYPES.has(type)) return 'transient';
  if (statusCode === 429) return 'transient';
  if (typeof statusCode === 'number' && statusCode >= 500 && statusCode <= 599) return 'transient';

  if (type && PERMANENT_STRIPE_ERROR_TYPES.has(type)) return 'terminal';
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 499) return 'terminal';

  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) return 'transient';

  // Unknown/unexpected error → terminal, matching the house default. Note the
  // worker keeps markOutboxCompleted OUTSIDE the Stripe try/catch precisely so
  // a transient Postgres error on the completion write never reaches this
  // classifier (it would mislabel a succeeded operation as terminal).
  return 'terminal';
}
