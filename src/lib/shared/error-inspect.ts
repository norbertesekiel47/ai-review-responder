// src/lib/shared/error-inspect.ts
//
// Single owner of the PROVIDER-AGNOSTIC error-inspection vocabulary: the
// retryable OS-socket error codes and the defensive property readers used to
// inspect unknown thrown values. Moved out of
// src/lib/payments/stripe-error-inspect.ts (#913) once its third non-Stripe
// consumer arrived — nothing below knows anything about Stripe, and a reader
// arriving from the solicitation send lane should not have to wonder what
// Stripe has to do with sending a review request.
//
// The Stripe error-TYPE sets stay in src/lib/payments/stripe-error-inspect.ts;
// the db-infra transient vocabulary stays in src/lib/db/transient-error.ts
// (this OS-socket set does NOT cover postgres.js connection-lifecycle codes or
// PG SQLSTATEs). Retry POLICY stays with each consumer; what must never drift
// independently is the vocabulary below — a retryable network code added for
// one consumer and not the others would make parallel paths retry differently
// for the same outage.

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
