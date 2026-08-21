// D12c's retry classification as a pure module (#899 Task 0 — the eval task).
//
// The classifier is the single owner of "may this send be tried again". It is
// PURE and TOTAL: `classifySendFailure` takes `unknown` because the thing being
// classified crossed a provider boundary, and it must never itself throw — a
// classifier that throws inside a catch block loses the original failure.
//
// Only three classes exist (D12c minus the two render-lane rows, which are out
// of scope: this worker makes no LLM call). `terminal_bounce` is the only class
// that stamps `bounced_at` and feeds the Suppression ledger, so a hard bounce
// mis-classified as `retryable` re-mails a dead address under a stable
// idempotency key, and a 5xx mis-classified as `terminal_bounce` suppresses a
// contact who never bounced. Neither is recoverable after the fact.
//
// This file is written BEFORE `../send-retry` exists. It fails with a module
// resolution error until Task 5 lands the module; that failure is the point.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EmailSendTimeoutError } from '@/lib/notifications/email/send-email';
import { classifySendFailure, type SendFailureClass } from '../send-retry';

/** The closed set. Typed against the module's own union so a fourth class
 *  added without updating this list is a TYPE error, not a silent pass. */
const SEND_FAILURE_CLASSES: readonly SendFailureClass[] = [
  'terminal_bounce',
  'retryable',
  'terminal_other',
];

/**
 * The shape EmailAdapter actually throws: `new Error(msg, { cause })` where
 * `cause` is Resend's `{ name, message }` error object (email-adapter.ts:71).
 * Built here rather than hand-waved so the classifier is specified against the
 * real seam, not an invented one.
 */
function resendFailure(name: string, statusCode: number): Error {
  return new Error('Resend refused the solicitation send', {
    cause: { name, message: `resend: ${name}`, statusCode },
  });
}

describe('classifySendFailure', () => {
  it('classifies a provider 5xx, timeout or rate limit as retryable', () => {
    // Resend's own per-team pacing surfaces as a 429. #899 only CLASSIFIES it;
    // the pacer itself is #900's (locked decision 2).
    expect(classifySendFailure(resendFailure('rate_limit_exceeded', 429))).toBe('retryable');
    expect(classifySendFailure(resendFailure('internal_server_error', 500))).toBe('retryable');
    expect(classifySendFailure(resendFailure('application_error', 503))).toBe('retryable');

    // The bounded-timeout half of CLAUDE.md's outbound-call rule. sendEmail
    // races the SDK against its own timer and throws this — a timeout means
    // "we do not know", which is retryable under the same idempotency key.
    expect(classifySendFailure(new EmailSendTimeoutError(10_000))).toBe('retryable');
  });

  // The class that stamps `bounced_at`. Resend names the offending field in the
  // message, and the classifier requires that signal — see the module comment on
  // why the bounce test is the narrowest of the three.
  it('classifies a provider 4xx invalid-recipient as terminal_bounce', () => {
    const badRecipient = new Error('Resend refused the solicitation send', {
      cause: {
        name: 'validation_error',
        message: 'Invalid `to` field. Please use the correct format.',
        statusCode: 422,
      },
    });
    expect(classifySendFailure(badRecipient)).toBe('terminal_bounce');
  });

  // The two errors that must NEVER stamp `bounced_at`: a config fault carries no
  // statement about the customer's address, and an unrecognisable throw carries
  // no statement at all. Both are terminal, neither suppresses a contact.
  it('never stamps a bounce for a configuration fault or an unrecognisable throw', () => {
    expect(classifySendFailure(resendFailure('invalid_from_address', 403))).toBe('terminal_other');
    expect(classifySendFailure(resendFailure('missing_required_field', 422))).toBe('terminal_other');
    expect(classifySendFailure(new Error('SOLICITATION_RESEND_API_KEY is not set'))).toBe(
      'terminal_other',
    );
    expect(classifySendFailure('a provider SDK rejected with a string')).toBe('terminal_other');
    expect(classifySendFailure(undefined)).toBe('terminal_other');
  });
});

// Property tests (fast-check): the house style for invariant-level coverage —
// see `classifySentiment invariants` in src/lib/reviews/__tests__/sentiment.test.ts.
describe('classifySendFailure invariants', () => {
  const arbResendError = fc.record({
    name: fc.constantFrom(
      'rate_limit_exceeded',
      'internal_server_error',
      'application_error',
      'validation_error',
      'invalid_parameter',
      'missing_required_field',
      'not_found',
    ),
    message: fc.string(),
    statusCode: fc.constantFrom(400, 401, 403, 404, 422, 429, 500, 502, 503),
  });

  /** Everything a catch block can actually receive: the adapter's wrapped
   *  throw, the timeout class, a bare Error, and non-Error junk — a provider
   *  SDK is free to reject with a string, and `unknown` says so. */
  const arbThrown: fc.Arbitrary<unknown> = fc.oneof(
    arbResendError.map((cause) => new Error('Resend refused the solicitation send', { cause })),
    fc.integer({ min: 1, max: 60_000 }).map((ms) => new EmailSendTimeoutError(ms)),
    fc.string().map((message) => new Error(message)),
    fc.anything(),
  );

  it('property: every provider error maps to exactly one retry class', () => {
    fc.assert(
      fc.property(arbThrown, (thrown) => {
        // TOTAL — no input escapes the table. An unclassifiable error must land
        // in `terminal_other`, never propagate out of the classifier.
        const verdict = classifySendFailure(thrown);
        expect(SEND_FAILURE_CLASSES).toContain(verdict);

        // EXACTLY ONE — the classes are mutually exclusive, so the same input
        // cannot be both retryable and terminal, and re-classifying the same
        // error (which the in-process retry loop does on every attempt) can
        // never flip a decision mid-flight.
        expect(SEND_FAILURE_CLASSES.filter((cls) => cls === verdict)).toHaveLength(1);
        expect(classifySendFailure(thrown)).toBe(verdict);
      }),
    );
  });
});
