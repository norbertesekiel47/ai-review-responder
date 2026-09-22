import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type { Sql } from 'postgres';

const {
  mockCheckoutSessionRetrieve,
  mockProcessCheckoutSessionCompleted,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockRecordOutboxTransientError,
} = vi.hoisted(() => ({
  mockCheckoutSessionRetrieve: vi.fn(),
  mockProcessCheckoutSessionCompleted: vi.fn(),
  mockMarkOutboxCompleted: vi.fn(),
  mockMarkOutboxFailed: vi.fn(),
  mockRecordOutboxTransientError: vi.fn(),
}));

vi.mock('../../../../src/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        retrieve: mockCheckoutSessionRetrieve,
      },
    },
  }),
}));

vi.mock('../../../ingress/stripe/checkout-completed', () => ({
  processCheckoutSessionCompleted: mockProcessCheckoutSessionCompleted,
}));

vi.mock('../../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  recordOutboxTransientError: mockRecordOutboxTransientError,
  extractOutboxHandle: vi.fn((data: { outbox_id?: string; outbox_attempt?: number }, jobId: string) => ({
    outboxId: data.outbox_id ?? jobId,
    attempt: data.outbox_attempt ?? 1,
  })),
}));

import { handleStripeCheckoutReconcile } from '../StripeCheckoutReconcileWorker';

function mockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    data: {
      account_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      checkout_session_id: 'cs_test_paid',
      correlation_id: 'corr-1',
      outbox_id: 'outbox-1',
      outbox_attempt: 1,
      ...overrides,
    },
  } as any;
}

describe('StripeCheckoutReconcileWorker', () => {
  // The handler only FORWARDS `sql` to the (mocked) outbox writers here — it runs
  // no query itself — so a sentinel suffices; assertions pin it as the leading arg.
  const fakeSql = {} as unknown as Sql;

  beforeEach(() => {
    mockCheckoutSessionRetrieve.mockReset();
    mockProcessCheckoutSessionCompleted.mockReset();
    mockMarkOutboxCompleted.mockReset();
    mockMarkOutboxFailed.mockReset();
    mockRecordOutboxTransientError.mockReset();
  });

  it('retrieves the Checkout Session in the worker and processes the existing activation handler', async () => {
    const session = {
      id: 'cs_test_paid',
      client_reference_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      mode: 'subscription',
      payment_status: 'paid',
    };
    mockCheckoutSessionRetrieve.mockResolvedValueOnce(session);

    await handleStripeCheckoutReconcile(fakeSql, mockJob());

    expect(mockCheckoutSessionRetrieve).toHaveBeenCalledWith('cs_test_paid');
    expect(mockProcessCheckoutSessionCompleted).toHaveBeenCalledWith(session);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(fakeSql, 'outbox-1', 1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('fails the outbox row without activation when the Checkout Session belongs to a different account', async () => {
    mockCheckoutSessionRetrieve.mockResolvedValueOnce({
      id: 'cs_test_paid',
      client_reference_id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
      mode: 'subscription',
      payment_status: 'paid',
    });

    await handleStripeCheckoutReconcile(fakeSql, mockJob());

    expect(mockProcessCheckoutSessionCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      fakeSql,
      'outbox-1',
      'checkout_session_account_mismatch',
      1,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  // #1364 — transient vs terminal. The classifiers (classifyStripeOverageError,
  // isTransientPostgresError) run for real; only the outbox writers are mocked.
  // A transient error must leave the row 'dispatched' (recordOutboxTransientError
  // only) and rethrow the ORIGINAL error so BullMQ retries; a terminal error marks
  // the row failed and throws UnrecoverableError so BullMQ does not re-run it.

  function stripeError(overrides: Record<string, unknown>): Error {
    return Object.assign(new Error('stripe error'), overrides);
  }

  it.each([
    ['StripeConnectionError (no HTTP round-trip)', stripeError({ type: 'StripeConnectionError' })],
    ['StripeAPIError 503', stripeError({ type: 'StripeAPIError', statusCode: 503 })],
    ['StripeRateLimitError 429', stripeError({ type: 'StripeRateLimitError', statusCode: 429 })],
    ['ECONNRESET socket code', stripeError({ code: 'ECONNRESET' })],
  ])('a transient Stripe retrieval error (%s) leaves the outbox row retryable and rethrows the original error', async (_label, err) => {
    mockCheckoutSessionRetrieve.mockRejectedValueOnce(err);

    await expect(handleStripeCheckoutReconcile(fakeSql, mockJob())).rejects.toBe(err);

    expect(mockProcessCheckoutSessionCompleted).not.toHaveBeenCalled();
    expect(mockRecordOutboxTransientError).toHaveBeenCalledWith(fakeSql, 'outbox-1', 'stripe error', 1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('a transient Postgres error inside processCheckoutSessionCompleted is retried, not terminal-failed', async () => {
    mockCheckoutSessionRetrieve.mockResolvedValueOnce({
      id: 'cs_test_paid',
      client_reference_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const err = Object.assign(new Error('write CONNECTION_CLOSED'), { code: 'CONNECTION_CLOSED' });
    mockProcessCheckoutSessionCompleted.mockRejectedValueOnce(err);

    await expect(handleStripeCheckoutReconcile(fakeSql, mockJob())).rejects.toBe(err);

    expect(mockRecordOutboxTransientError).toHaveBeenCalledWith(fakeSql, 'outbox-1', 'write CONNECTION_CLOSED', 1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('a later successful retry after a transient error completes the same outbox attempt', async () => {
    const session = {
      id: 'cs_test_paid',
      client_reference_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    };
    mockCheckoutSessionRetrieve
      .mockRejectedValueOnce(stripeError({ type: 'StripeAPIError', statusCode: 502 }))
      .mockResolvedValueOnce(session);

    await expect(handleStripeCheckoutReconcile(fakeSql, mockJob())).rejects.toThrow('stripe error');
    // BullMQ retry: same job data, same outbox attempt — the row is still 'dispatched'.
    await handleStripeCheckoutReconcile(fakeSql, mockJob());

    expect(mockRecordOutboxTransientError).toHaveBeenCalledTimes(1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    expect(mockProcessCheckoutSessionCompleted).toHaveBeenCalledWith(session);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(fakeSql, 'outbox-1', 1);
  });

  it.each([
    ['StripeInvalidRequestError 404 (no such session)', stripeError({ type: 'StripeInvalidRequestError', statusCode: 404 })],
    ['StripeAuthenticationError 401', stripeError({ type: 'StripeAuthenticationError', statusCode: 401 })],
    ['code-less generic Error (house default)', new Error('stripe error')],
  ])('a terminal error (%s) marks the outbox row failed and throws UnrecoverableError', async (_label, err) => {
    mockCheckoutSessionRetrieve.mockRejectedValueOnce(err);

    const rejection = handleStripeCheckoutReconcile(fakeSql, mockJob());
    await expect(rejection).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(rejection).rejects.toThrow('stripe error');

    expect(mockProcessCheckoutSessionCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(fakeSql, 'outbox-1', 'stripe error', 1);
    expect(mockRecordOutboxTransientError).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('a terminal error thrown by processCheckoutSessionCompleted after a successful retrieve is terminal too', async () => {
    mockCheckoutSessionRetrieve.mockResolvedValueOnce({
      id: 'cs_test_paid',
      client_reference_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    mockProcessCheckoutSessionCompleted.mockRejectedValueOnce(new Error('activation invariant violated'));

    await expect(handleStripeCheckoutReconcile(fakeSql, mockJob())).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(fakeSql, 'outbox-1', 'activation invariant violated', 1);
    expect(mockRecordOutboxTransientError).not.toHaveBeenCalled();
  });
});
