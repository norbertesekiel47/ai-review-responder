import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';

/**
 * checkout.session.completed handler (worker/ingress/stripe/checkout-completed.ts):
 * account activation (VAL-BILLING-007/008/060). The post-activation Zernio
 * backfill-resume branch lives in stripe-activation-enqueue.test.ts.
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
  queueCheckoutActivate,
  mockRetrieveSession,
  mockRetrieveSubscription,
} = await vi.hoisted(async () => {
  const { createStripeWebhookHarness } = await import('./helpers/stripe-webhook-harness');
  return {
    ...createStripeWebhookHarness(),
    mockRetrieveSession: vi.fn(),
    mockRetrieveSubscription: vi.fn(),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../../../src/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    checkout: { sessions: { retrieve: mockRetrieveSession } },
    subscriptions: {
      retrieve: mockRetrieveSubscription,
      cancel: vi.fn(),
    },
  }),
}));
vi.mock('../shared', () => ({ claimInboundEvent: mockClaimInboundEvent }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mockConstructEvent };
  },
}));

import {
  installStripeWebhookEnv,
  mkRequest,
  mkReply,
  TEST_ACCOUNT_ID,
  TEST_CUSTOMER_ID,
  TEST_SUBSCRIPTION_ID,
} from './helpers/stripe-webhook-harness';
import { handleStripeWebhook } from '../stripe';

const restoreStripeWebhookEnv = installStripeWebhookEnv();
afterAll(restoreStripeWebhookEnv);

function isAccountStatusUpdate(
  call: (typeof sqlCalls)[number],
  status: string,
): boolean {
  return /\bUPDATE\s+accounts\b/.test(call.text) && call.values.includes(status);
}

beforeEach(() => {
  resetStripeWebhookMocks();
  mockRetrieveSession.mockReset();
  mockRetrieveSession.mockImplementation(async (sessionId: string) => ({
    id: sessionId,
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    client_reference_id: TEST_ACCOUNT_ID,
    customer: TEST_CUSTOMER_ID,
    subscription: TEST_SUBSCRIPTION_ID,
    metadata: {
      checkout_attempt_id: '019dc366-29ce-7000-a000-0000000000cc',
    },
    line_items: {
      data: [{ quantity: 1, price: { id: 'price_copilot_list_test' } }],
    },
  }));
  mockRetrieveSubscription.mockReset();
  mockRetrieveSubscription.mockResolvedValue({
    id: TEST_SUBSCRIPTION_ID,
    customer: TEST_CUSTOMER_ID,
    status: 'active',
    trial_end: null,
    metadata: {
      checkout_attempt_id: '019dc366-29ce-7000-a000-0000000000cc',
    },
    items: {
      data: [{
        id: 'si_base',
        quantity: 1,
        metadata: {},
        price: { id: 'price_copilot_list_test', metadata: {}, unit_amount: 2900 },
      }],
    },
  });
});

describe('checkout.session.completed — account activation (VAL-BILLING-007, VAL-BILLING-008)', () => {
  it('activates pending_payment account with stripe_customer_id and subscription_id', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_activate',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: TEST_ACCOUNT_ID,
          customer: TEST_CUSTOMER_ID,
          subscription: TEST_SUBSCRIPTION_ID,
        },
      },
    });

    queueCheckoutActivate({ sessionId: 'cs_test' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // Applier writes 'active' with COALESCE'd Stripe ids — verify both appear.
    // NOTE: stripe_customer_id / stripe_subscription_id on businesses are deprecated
    // (VAL-SCHEMA-037); the applier does NOT write them. The accounts row gets them
    // via the applier's COALESCE write (first-writer-wins, invariant #3).
    const updateAcct = sqlCalls.find(
      (call) => isAccountStatusUpdate(call, SubscriptionStatus.ACTIVE),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain(TEST_CUSTOMER_ID);
    expect(updateAcct!.values).toContain(TEST_SUBSCRIPTION_ID);
    expect(sqlCalls).toHaveLength(17);
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('VAL-BILLING-008: completed active replay is an idempotent no-op', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_dup',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_dup',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: TEST_ACCOUNT_ID,
          customer: TEST_CUSTOMER_ID,
          subscription: TEST_SUBSCRIPTION_ID,
        },
      },
    });

    // already-active: applier's isAllowedTransition(active→active)=false → no UPDATEs
    queueCheckoutActivate({ status: 'active', sessionId: 'cs_test_dup' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // No UPDATE accounts for 'active' (idempotent no-op)
    const updateAcct = sqlCalls.find(
      (call) => isAccountStatusUpdate(call, SubscriptionStatus.ACTIVE),
    );
    expect(updateAcct).toBeUndefined();
    expect(sqlCalls).toHaveLength(10);
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('VAL-BILLING-060: uses client_reference_id as account ID', async () => {
    const customAccountId = '019dc366-aaaa-bbbb-cccc-dddddddddddd';
    mockConstructEvent.mockReturnValue({
      id: 'evt_checkout_crid',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_crid',
          mode: 'subscription',
          payment_status: 'paid',
          client_reference_id: customAccountId,
          customer: 'cus_custom',
          subscription: 'sub_custom',
        },
      },
    });

    queueCheckoutActivate({
      accountId: customAccountId,
      sessionId: 'cs_test_crid',
      customerId: 'cus_custom',
      subscriptionId: 'sub_custom',
    });
    mockRetrieveSession.mockResolvedValueOnce({
      id: 'cs_test_crid',
      mode: 'subscription',
      status: 'complete',
      payment_status: 'paid',
      client_reference_id: customAccountId,
      customer: 'cus_custom',
      subscription: 'sub_custom',
      metadata: {
        checkout_attempt_id: '019dc366-29ce-7000-a000-0000000000cc',
      },
      line_items: {
        data: [{ quantity: 1, price: { id: 'price_copilot_list_test' } }],
      },
    });
    mockRetrieveSubscription.mockResolvedValueOnce({
      id: 'sub_custom',
      customer: 'cus_custom',
      status: 'active',
      trial_end: null,
      metadata: {
        checkout_attempt_id: '019dc366-29ce-7000-a000-0000000000cc',
      },
      items: {
        data: [{
          id: 'si_base', quantity: 1, metadata: {},
          price: { id: 'price_copilot_list_test', metadata: {}, unit_amount: 2900 },
        }],
      },
    });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // The pre-tx SELECT accounts lookup carries the customAccountId as a parameter
    const lookupCall = sqlCalls.find(
      (c) => c.text.includes('SELECT') && c.text.includes('accounts') && c.text.includes('id'),
    );
    expect(lookupCall).toBeDefined();
    expect(lookupCall!.values).toContain(customAccountId);
    expect(sqlCalls).toHaveLength(17);
    expect(sqlReturnQueue).toHaveLength(0);
  });
});
