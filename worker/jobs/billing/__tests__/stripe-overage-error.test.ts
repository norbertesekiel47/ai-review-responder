// worker/jobs/billing/__tests__/stripe-overage-error.test.ts
//
// Unit tests for classifyStripeOverageError — the transient/terminal classifier
// that decides whether UpdateStripeOverageWorker leaves the outbox row
// 'dispatched' (transient → BullMQ retry + 1h watchdog re-dispatch) or marks it
// 'failed' (terminal → deterministic, never heals).
//
// Diverges from the house pattern (stripe-invoices.ts) on ONE point: a 409
// in-flight idempotency conflict is TRANSIENT here (a concurrent same-key request
// is still processing — retry), whereas the house classifier treats all
// StripeIdempotencyError / 4xx as terminal.

import { describe, it, expect } from 'vitest';
import { classifyStripeOverageError } from '../stripe-overage-error';

describe('classifyStripeOverageError', () => {
  it('classifies a 400 idempotency_error as terminal (key reuse with different params — never heals)', () => {
    expect(
      classifyStripeOverageError({
        type: 'StripeInvalidRequestError',
        code: 'idempotency_error',
        statusCode: 400,
      }),
    ).toBe('terminal');
  });

  it('classifies a 409 in-flight idempotency conflict as transient', () => {
    expect(
      classifyStripeOverageError({
        type: 'StripeIdempotencyError',
        statusCode: 409,
      }),
    ).toBe('transient');
  });

  it('classifies a StripeRateLimitError (429) as transient', () => {
    expect(
      classifyStripeOverageError({ type: 'StripeRateLimitError', statusCode: 429 }),
    ).toBe('transient');
  });

  it('classifies a bare 429 statusCode (no Stripe type) as transient', () => {
    expect(classifyStripeOverageError({ statusCode: 429 })).toBe('transient');
  });

  it('classifies a StripeConnectionError as transient', () => {
    expect(classifyStripeOverageError({ type: 'StripeConnectionError' })).toBe('transient');
  });

  it('classifies a 503 server error as transient', () => {
    expect(classifyStripeOverageError({ statusCode: 503 })).toBe('transient');
  });

  it('classifies a StripeAuthenticationError as terminal', () => {
    expect(
      classifyStripeOverageError({ type: 'StripeAuthenticationError', statusCode: 401 }),
    ).toBe('terminal');
  });

  it('classifies a 404 StripeInvalidRequestError (resource_missing) as terminal', () => {
    expect(
      classifyStripeOverageError({
        type: 'StripeInvalidRequestError',
        code: 'resource_missing',
        statusCode: 404,
      }),
    ).toBe('terminal');
  });

  it('classifies an ECONNRESET network error code as transient', () => {
    expect(classifyStripeOverageError({ code: 'ECONNRESET' })).toBe('transient');
  });

  it('classifies a plain Error with no Stripe shape as terminal (default)', () => {
    expect(classifyStripeOverageError(new Error('boom'))).toBe('terminal');
  });

  it('reads statusCode from the `status` property when `statusCode` is absent', () => {
    expect(classifyStripeOverageError({ status: 409 })).toBe('transient');
  });
});
