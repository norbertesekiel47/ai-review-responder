import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

/**
 * Webhook idempotency + error handling (VAL-BILLING-051/067): claimInboundEvent dedup
 * short-circuit, processing failure -> 500, success -> 200. Cross-cutting.
 *
 * Split out of the former stripe-webhook-handlers.test.ts (issue #268). Mock graph
 * + queue helpers come from the shared ./helpers/stripe-webhook-harness, which
 * builds the Postgres.js mock from the canonical worker/__tests__/helpers/mock-sql.
 */

// ── Hoisted mocks (shared stripe-webhook harness) ──────────────────
const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  mockClaimInboundEvent,
  mockConstructEvent,
  mockWriteAccountAuditLog,
  resetStripeWebhookMocks,
  queueInvoicePaymentFailed,
  mockRetrieveSubscription,
} = await vi.hoisted(async () => {
  const { createStripeWebhookHarness } = await import('./helpers/stripe-webhook-harness');
  return {
    ...createStripeWebhookHarness(),
    mockRetrieveSubscription: vi.fn(),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../shared', () => ({ claimInboundEvent: mockClaimInboundEvent }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mockConstructEvent };
    subscriptions = { retrieve: mockRetrieveSubscription };
  },
}));

import {
  installStripeWebhookEnv,
  mkRequest,
  mkReply,
  TEST_CUSTOMER_ID,
  TEST_SUBSCRIPTION_ID,
} from './helpers/stripe-webhook-harness';
import { handleStripeWebhook } from '../stripe';

const restoreStripeWebhookEnv = installStripeWebhookEnv();
afterAll(restoreStripeWebhookEnv);

beforeEach(() => {
  resetStripeWebhookMocks();
  mockRetrieveSubscription.mockReset();
  mockRetrieveSubscription.mockResolvedValue({
    id: TEST_SUBSCRIPTION_ID,
    customer: TEST_CUSTOMER_ID,
    status: 'past_due',
    trial_end: null,
    metadata: {},
    items: { data: [] },
  });
});

afterEach(() => {
  expect(sqlReturnQueue).toEqual([]);
});

describe('Webhook idempotency and error handling', () => {
  it('VAL-BILLING-051: duplicate event ID is short-circuited by claimInboundEvent dedup', async () => {
    mockClaimInboundEvent.mockResolvedValueOnce('duplicate');
    mockConstructEvent.mockReturnValue({
      id: 'evt_idem_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: {
            data: [
              { price: { id: 'price_copilot_list_test' }, quantity: 1 },
              { price: { id: 'price_copilot_overage_test' }, quantity: 3 },
            ],
          },
        },
      },
    });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // No SQL should have fired for the duplicate — short-circuited at claimInboundEvent
    const acctUpdates = sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text),
    );
    expect(acctUpdates).toEqual([]);
    expect(mockRetrieveSubscription).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(0);
  });

  it('VAL-BILLING-067: processing failure returns 500 so Stripe retries', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_fail_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_fail_1', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    // Make the first SQL call inside tx throw
    mockSql.mockImplementationOnce(() => { throw new Error('Connection lost'); });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(500);
    expect(mockRetrieveSubscription).not.toHaveBeenCalled();
    expect(sqlCalls).toHaveLength(1);
  });

  it('successfully processed event returns 200', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_success_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_success_1', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaymentFailed({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    expect(mockRetrieveSubscription).toHaveBeenCalledTimes(1);
    expect(sqlCalls).toHaveLength(7);
  });
});
