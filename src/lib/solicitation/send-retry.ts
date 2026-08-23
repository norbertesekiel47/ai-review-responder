// src/lib/solicitation/send-retry.ts
//
// D12c's retry classification for the Solicitation SEND lane (#899), as a pure
// named module — the executor design's own reading of invariant #12: "the send
// worker maps errors and delegates; retry classification (D12c) lives in a named
// module with focused tests" (send-mode-executor-approval-design.md:1115).
//
// PURE and TOTAL: no I/O, no clock, no DB. `classifySendFailure` takes `unknown`
// because the value crossed a provider boundary, and it must never itself throw —
// a classifier that throws inside a catch block loses the original failure.
//
// ── SCOPE: two of D12c's four rows are NOT this module's ──────────────────────
// D12c's other two rows — `CostInfraUnavailableError` (the pre-LLM Redis
// transport failure, #255) and "budget exceeded" — belong to the RENDER lane
// (#628, `ask-generation.ts`), not here. THIS WORKER MAKES NO LLM CALL: its only
// outbound calls are the OpenAI moderation endpoint, which is free
// (docs/superpowers/specs/2026-07-28-ask-generation-design.md §3.4), and the
// Messaging adapter send. **Do not add a cost guard here.**
//
// ── SCOPE: pacing is NOT this module's job ────────────────────────────────────
// Resend's 10 req/s limit is per TEAM, not per key, so both sending identities
// share one budget. Pacing is #900's, at release level. All this module does with
// a 429 is call it `retryable`; it must never grow a backoff, a token bucket, or
// any scheduling.
//
// ── HOW FAILURES ARRIVE ───────────────────────────────────────────────────────
// `MessagingAdapter.send` THROWS on every failure (messaging-adapter.ts:48-62),
// so classification reads a thrown value, never a return value. Three shapes
// reach a catch block today:
//   1. `new Error(msg, { cause: ErrorResponse })` — `EmailAdapter` converting
//      Resend's `{ data, error }` into a throw (email-adapter.ts:71). Resend's
//      `ErrorResponse` is `{ message, statusCode: number | null, name }`, so the
//      provider's own fields live on `cause`, never on the wrapper.
//   2. `EmailSendTimeoutError` — `sendEmail`'s bounded-timeout half of CLAUDE.md's
//      outbound-call rule. "We do not know" ⇒ retryable under the same provider
//      idempotency key (D12b), which is what makes the retry safe.
//   3. A transport rejection from `fetch` under the SDK, carrying an OS socket
//      code on itself or its `cause`.
//
// ── WHY THE BOUNCE CLASS IS THE NARROWEST ─────────────────────────────────────
// `terminal_bounce` is the only class that stamps `bounced_at`, which feeds the
// Suppression ledger and the Send breaker's hard-bounce numerator. Both
// misclassifications are unrecoverable: a hard bounce called `retryable`
// re-mails a dead address, and a 5xx called `terminal_bounce` suppresses a
// contact who never bounced. So the bounce test is a conjunction — 4xx status
// AND a recipient-scoped Resend code AND a recipient-field signal in the
// provider's message — following `isStripeCouponError`
// (src/lib/payments/stripe-error-inspect.ts), which reads the offending FIELD
// before trusting the code precisely because a shared code ("resource_missing")
// would otherwise misfile a missing price as a coupon fault. Same hazard here:
// `validation_error` covers a bad subject as readily as a bad recipient.
// Anything undeterminable falls to `terminal_other` — terminal, but it neither
// re-sends nor suppresses, which is the safe direction for both errors.

import { EmailSendTimeoutError } from '@/lib/notifications/email/send-email';
import {
  RETRYABLE_NETWORK_ERROR_CODES,
  errorNumberProperty,
  errorStringProperty,
} from '@/lib/shared/error-inspect';

/** D12c's classes. `terminal_bounce` is the only one that stamps `bounced_at`. */
export type SendFailureClass = 'terminal_bounce' | 'retryable' | 'terminal_other';

/**
 * 4xx statuses that mean "try again", not "this request is wrong" — excluded
 * from the bounce range below so a throttled send can never be read as a dead
 * address.
 */
const RETRYABLE_CLIENT_STATUS_CODES: ReadonlySet<number> = new Set([408, 429]);

/**
 * Members of Resend's `RESEND_ERROR_CODE_KEY` union that name a server-side or
 * throttle condition unambiguously. Consulted ONLY when `statusCode` is absent —
 * `ErrorResponse.statusCode` is typed `number | null`, and a null one must not
 * make a plain 5xx unretryable.
 */
const RETRYABLE_RESEND_CODES: ReadonlySet<string> = new Set([
  'internal_server_error',
  'application_error',
  'rate_limit_exceeded',
  // Resend's own "this idempotency key is mid-flight" answer: the correct
  // response is to re-issue the same key, which is exactly what a retry does.
  'concurrent_idempotent_requests',
]);

/**
 * The only Resend codes a recipient rejection can arrive under. Deliberately
 * omits `missing_required_field` (our payload bug), `invalid_from_address`,
 * `invalid_api_key` and the other configuration faults — none of them says
 * anything about the customer's address, and stamping `bounced_at` for one would
 * suppress a contact over our own misconfiguration.
 */
const RECIPIENT_REJECTED_RESEND_CODES: ReadonlySet<string> = new Set([
  'validation_error',
  'invalid_parameter',
]);

/** Resend names the offending field in the message: "Invalid `to` field. …". */
const RECIPIENT_FIELD_SIGNAL = /`to`|\bto field\b|recipient|email address/i;

/** The provider-owned fields, wherever on the thrown value they live. */
interface ProviderFailureSignal {
  statusCode?: number;
  /** Resend's `ErrorResponse.name` — an error CODE, not a JS error name. */
  code?: string;
  message?: string;
}

/** `err.cause` when there is one, without assuming `err` is an object at all. */
function causeOf(err: unknown): unknown {
  if (!err || typeof err !== 'object' || !('cause' in err)) return undefined;
  return (err as { cause: unknown }).cause;
}

/**
 * Reads the provider's fields from the `cause` FIRST: the adapter wraps Resend's
 * `ErrorResponse` there, and the wrapper's own `name` is the useless literal
 * `'Error'`, which would shadow the real code if the wrapper were read first.
 */
function readProviderSignal(err: unknown): ProviderFailureSignal {
  for (const candidate of [causeOf(err), err]) {
    const code = errorStringProperty(candidate, 'name');
    const statusCode = errorNumberProperty(candidate, 'statusCode');
    if (code === undefined && statusCode === undefined) continue;
    const signal: ProviderFailureSignal = {};
    if (statusCode !== undefined) signal.statusCode = statusCode;
    if (code !== undefined) signal.code = code;
    const message = errorStringProperty(candidate, 'message');
    if (message !== undefined) signal.message = message;
    return signal;
  }
  return {};
}

/** Timeouts and OS-level socket failures — no HTTP response ever came back. */
function isRetryableTransportFailure(err: unknown): boolean {
  if (err instanceof EmailSendTimeoutError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  // undici surfaces a socket failure as `TypeError: fetch failed` with the real
  // code on `cause`, so both levels are checked. The code set is imported rather
  // than re-spelled: it is provider-agnostic despite its file, and a second copy
  // is exactly the drift that file's header warns about.
  return [err, causeOf(err)].some((candidate) => {
    const code = errorStringProperty(candidate, 'code');
    return code !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(code);
  });
}

/** D12c row 2: provider 5xx or rate-limit. */
function isRetryableProviderFailure(signal: ProviderFailureSignal): boolean {
  const { statusCode, code } = signal;
  // When the provider gave a status it is authoritative; the code name is only
  // the fallback for Resend's `statusCode: null`.
  if (statusCode !== undefined) {
    return statusCode >= 500 || RETRYABLE_CLIENT_STATUS_CODES.has(statusCode);
  }
  return code !== undefined && RETRYABLE_RESEND_CODES.has(code);
}

/** D12c row 1: provider 4xx invalid-recipient / hard bounce. */
function isRecipientRejection(signal: ProviderFailureSignal): boolean {
  const { statusCode, code, message } = signal;
  if (statusCode === undefined || statusCode < 400 || statusCode >= 500) return false;
  if (RETRYABLE_CLIENT_STATUS_CODES.has(statusCode)) return false;
  if (code === undefined || !RECIPIENT_REJECTED_RESEND_CODES.has(code)) return false;
  return message !== undefined && RECIPIENT_FIELD_SIGNAL.test(message);
}

/**
 * D12c's table. Total over `unknown`: anything the three rows cannot name lands
 * in `terminal_other`, which neither re-sends nor suppresses.
 */
export function classifySendFailure(err: unknown): SendFailureClass {
  if (isRetryableTransportFailure(err)) return 'retryable';
  const signal = readProviderSignal(err);
  if (isRecipientRejection(signal)) return 'terminal_bounce';
  if (isRetryableProviderFailure(signal)) return 'retryable';
  return 'terminal_other';
}
