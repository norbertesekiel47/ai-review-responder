// src/lib/shared/error-inspect.ts
//
// Single owner of the PROVIDER-AGNOSTIC error-inspection vocabulary: the
// retryable OS-socket error codes and the defensive property readers used to
// inspect unknown thrown values, plus the one log-safe `boundedErrorClass`
// (#1381). The vocabulary half moved out of
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

/**
 * The ONE bounded, log-safe class name for a thrown value (#1381) — the
 * `error_class` log field and the `<lane>_exhausted:<class>` outbox reasons.
 * One definition, so the same error yields the same value on every lane:
 * the field is only worth having if it is comparable across lanes.
 *
 * `constructor.name`, NOT `err.name`: they diverge for any class that does not
 * assign `this.name`, and the provider SDKs do not — every `openai` and
 * `@anthropic-ai/sdk` error reads `err.name === 'Error'`, while its constructor
 * says `RateLimitError` or `APIConnectionTimeoutError`. Our own classes assign
 * `this.name` to the class name, so for them the two agree. The worker runs
 * unminified under tsx, so constructor names survive. Known cost: a
 * `DOMException` reports `DOMException`, not `AbortError`. Classifiers that
 * match a specific name (e.g. the judge's budget check) keep reading `err.name`
 * — that is a different question.
 *
 * The identifier-shape check bounds the length and keeps a hostile or exotic
 * class name from injecting structure into a log line or a durable
 * `job_outbox.last_error`. A non-Error, or a name that fails the shape, is
 * `'UnknownError'`. The message is never read: it may embed contact handles.
 */
export function boundedErrorClass(err: unknown): string {
  if (!(err instanceof Error)) return 'UnknownError';
  // Read defensively: `constructor` is an ordinary, overwritable property, and
  // this runs inside `failed` listeners where a throw is an unhandled rejection.
  const constructorName: unknown = (err.constructor as { name?: unknown } | undefined)?.name;
  return typeof constructorName === 'string' &&
    /^[A-Za-z][A-Za-z0-9_$]{0,99}$/.test(constructorName)
    ? constructorName
    : 'UnknownError';
}
