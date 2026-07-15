import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

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
vi.mock('../../../src/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockRetrieveSubscription },
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

beforeEach(() => {
  resetStripeWebhookMocks();
  mockRetrieveSubscription.mockReset();
  mockRetrieveSubscription.mockResolvedValue({
    id: TEST_SUBSCRIPTION_ID,
    customer: TEST_CUSTOMER_ID,
    status: 'active',
    trial_end: null,
    metadata: {},
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

    queueCheckoutActivate();

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // Applier writes 'active' with COALESCE'd Stripe ids — verify both appear.
    // NOTE: stripe_customer_id / stripe_subscription_id on businesses are deprecated
    // (VAL-SCHEMA-037); the applier does NOT write them. The accounts row gets them
    // via the applier's COALESCE write (first-writer-wins, invariant #3).
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.values).toContain(TEST_CUSTOMER_ID);
    expect(updateAcct!.values).toContain(TEST_SUBSCRIPTION_ID);
    expect(sqlCalls).toHaveLength(18);
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('VAL-BILLING-008: already active → idempotent no-op (applier: isAllowedTransition returns false)', async () => {
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
    queueCheckoutActivate({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // No UPDATE accounts for 'active' (idempotent no-op)
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(updateAcct).toBeUndefined();
    expect(sqlCalls).toHaveLength(16);
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

    queueCheckoutActivate({ accountId: customAccountId });
    mockRetrieveSubscription.mockResolvedValueOnce({
      id: 'sub_custom',
      customer: 'cus_custom',
      status: 'active',
      trial_end: null,
      metadata: {},
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
    expect(sqlCalls).toHaveLength(18);
    expect(sqlReturnQueue).toHaveLength(0);
  });
});
