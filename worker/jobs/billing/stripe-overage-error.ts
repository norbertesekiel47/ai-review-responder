// worker/jobs/billing/stripe-overage-error.ts
//
// Transient/terminal classifier for UpdateStripeOverageWorker's Stripe calls.
//
// Mirrors the inspection shape of src/lib/account-offboarding/stripe-invoices.ts
// (stringProperty/numberProperty helpers, the same retryable/permanent type and
// statusCode rules, the same RETRYABLE_NETWORK_ERROR_CODES set), but DIVERGES on
// one point: a 409 in-flight idempotency conflict is TRANSIENT here, not terminal.
// The house classifier treats all StripeIdempotencyError / 4xx as terminal, which
// would wrongly make a concurrent same-key request (still processing) permanent.
// The overage worker needs the 409 retry, so it owns its own classifier rather
// than importing the house one.
//
// Semantics:
//   transient → leave the outbox row 'dispatched'; BullMQ retries and the 1h
//               outbox watchdog re-dispatches. Do NOT markOutboxFailed.
//   terminal  → deterministic failure that never heals; markOutboxFailed + re-throw.

type StripeOverageErrorClass = 'transient' | 'terminal';

const RETRYABLE_STRIPE_ERROR_TYPES = new Set([
  'StripeAPIConnectionError',
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
]);

const TERMINAL_STRIPE_ERROR_TYPES = new Set([
  'StripeAuthenticationError',
  'StripePermissionError',
  'StripeInvalidRequestError',
  'StripeIdempotencyError',
]);

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

export function classifyStripeOverageError(err: unknown): StripeOverageErrorClass {
  const type = stringProperty(err, 'type');
  const statusCode = numberProperty(err, 'statusCode') ?? numberProperty(err, 'status');
  const code = stringProperty(err, 'code');

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

  if (type && TERMINAL_STRIPE_ERROR_TYPES.has(type)) return 'terminal';
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 499) return 'terminal';

  if (code && RETRYABLE_NETWORK_ERROR_CODES.has(code)) return 'transient';

  // Unknown/unexpected error → terminal, matching the house default. A DB error
  // on markOutboxCompleted would land here, but markOutboxFailed is itself a DB
  // write that fails-closed when the DB is down — it throws, the handler rejects,
  // BullMQ retries, and the still-'dispatched' row is re-dispatched by the
  // watchdog — so default-terminal does not lose the recompute on a DB blip.
  return 'terminal';
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : undefined;
}

function numberProperty(value: unknown, property: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'number' ? candidate : undefined;
}
