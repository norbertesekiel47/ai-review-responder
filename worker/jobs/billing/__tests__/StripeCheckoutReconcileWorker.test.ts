import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCheckoutSessionRetrieve,
  mockProcessCheckoutSessionCompleted,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
} = vi.hoisted(() => ({
  mockCheckoutSessionRetrieve: vi.fn(),
  mockProcessCheckoutSessionCompleted: vi.fn(),
  mockMarkOutboxCompleted: vi.fn(),
  mockMarkOutboxFailed: vi.fn(),
}));

vi.mock('../../../../src/lib/payments/create-checkout-session', () => ({
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
  beforeEach(() => {
    mockCheckoutSessionRetrieve.mockReset();
    mockProcessCheckoutSessionCompleted.mockReset();
    mockMarkOutboxCompleted.mockReset();
    mockMarkOutboxFailed.mockReset();
  });

  it('retrieves the Checkout Session in the worker and processes the existing activation handler', async () => {
    const session = {
      id: 'cs_test_paid',
      client_reference_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      mode: 'subscription',
      payment_status: 'paid',
    };
    mockCheckoutSessionRetrieve.mockResolvedValueOnce(session);

    await handleStripeCheckoutReconcile(mockJob());

    expect(mockCheckoutSessionRetrieve).toHaveBeenCalledWith('cs_test_paid');
    expect(mockProcessCheckoutSessionCompleted).toHaveBeenCalledWith(session);
    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('fails the outbox row without activation when the Checkout Session belongs to a different account', async () => {
    mockCheckoutSessionRetrieve.mockResolvedValueOnce({
      id: 'cs_test_paid',
      client_reference_id: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
      mode: 'subscription',
      payment_status: 'paid',
    });

    await handleStripeCheckoutReconcile(mockJob());

    expect(mockProcessCheckoutSessionCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-1',
      'checkout_session_account_mismatch',
      1,
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
  });

  it('marks the outbox failed and rethrows when Stripe retrieval fails', async () => {
    mockCheckoutSessionRetrieve.mockRejectedValueOnce(new Error('Stripe unavailable'));

    await expect(handleStripeCheckoutReconcile(mockJob())).rejects.toThrow('Stripe unavailable');

    expect(mockProcessCheckoutSessionCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-1',
      'Stripe unavailable',
      1,
    );
  });
});
