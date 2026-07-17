import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * Out-of-order delivery (deep-scan 6.2): customer.subscription.* delivered BEFORE
 * checkout.session.completed has written accounts.stripe_customer_id -> 500 +
 * inbound_events failed -> Stripe redelivers -> applies exactly once. Cross-cutting.
 *
 * Split out of the former stripe-webhook-handlers.test.ts (issue #268). Mock graph
 * + queue helpers come from the shared ./helpers/stripe-webhook-harness, which
 * builds the Postgres.js mock from the canonical worker/__tests__/helpers/mock-sql.
 */

// ── Hoisted mocks (shared stripe-webhook harness) ──────────────────
const {
  mockSql,
  sqlCalls,
  sqlReturnQueue,
  mockClaimInboundEvent,
  mockConstructEvent,
  mockWriteAccountAuditLog,
  resetStripeWebhookMocks,
} = await vi.hoisted(async () => {
  const { createStripeWebhookHarness } = await import('./helpers/stripe-webhook-harness');
  return createStripeWebhookHarness();
});
const { mockRetrieveSubscription, mockApplyStripeSubscriptionState } = vi.hoisted(() => ({
  mockRetrieveSubscription: vi.fn(),
  mockApplyStripeSubscriptionState: vi.fn(),
}));

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../../../src/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: mockConstructEvent },
    subscriptions: { retrieve: mockRetrieveSubscription },
  }),
}));
vi.mock('../stripe/apply-subscription-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stripe/apply-subscription-state')>()),
  applyStripeSubscriptionStateUnderEntitlementLock: mockApplyStripeSubscriptionState,
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
  TEST_CUSTOMER_ID,
  TEST_SUBSCRIPTION_ID,
} from './helpers/stripe-webhook-harness';
import { handleStripeWebhook } from '../stripe';

const restoreStripeWebhookEnv = installStripeWebhookEnv();
afterAll(restoreStripeWebhookEnv);

beforeEach(() => {
  resetStripeWebhookMocks();
  mockRetrieveSubscription.mockReset();
  mockApplyStripeSubscriptionState.mockReset();
  mockApplyStripeSubscriptionState.mockResolvedValue({
    accountResolved: true,
    fromStatus: 'active',
    toStatus: 'active',
    changed: false,
    activated: false,
    primaryBusinessId: null,
  });
});

describe('out-of-order delivery — subscription.* before checkout.session.completed (deep-scan §6.2)', () => {
  function findInboundUpdate(statusValue: 'failed' | 'processed') {
    return sqlCalls.find((c) =>
      new RegExp(`UPDATE inbound_events\\s+SET status = '${statusValue}'`).test(c.text),
    );
  }
  function findTierApply() {
    return sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('subscription_tier'),
    );
  }

  it('subscription.updated with no matching account → throws → 500 + inbound_events failed (no tier write)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_ooo_updated_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: TEST_SUBSCRIPTION_ID,
          customer: TEST_CUSTOMER_ID,
          items: { data: [{ price: { id: 'price_copilot_list_test' }, quantity: 1 }] },
        },
      },
    });

    // checkout-completed has not yet written stripe_customer_id → SELECT misses.
    sqlReturnQueue.push([]);

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(500);
    expect(findInboundUpdate('failed')).toBeDefined();
    expect(findTierApply()).toHaveLength(0);
  });

  it('subscription.deleted with no matching account → throws → 500 + inbound_events failed (no cancel write)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_ooo_deleted_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID } },
    });

    sqlReturnQueue.push([]); // no account yet

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(500);
    expect(findInboundUpdate('failed')).toBeDefined();
    const cancelWrite = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'cancelled'"),
    );
    expect(cancelWrite).toBeUndefined();
  });

  it('full sequence: updated→500 → checkout writes customer → redeliver applies ONCE → 200; duplicate redelivery → 200 no-op', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_ooo_seq',
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

    // ── Delivery 1: account not provisioned → 500 + failed ──
    mockClaimInboundEvent.mockResolvedValueOnce('claimed');
    sqlReturnQueue.push([]); // SELECT misses
    let reply = mkReply();
    await handleStripeWebhook(mkRequest(), reply as any);
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(findInboundUpdate('failed')).toBeDefined();

    // ── checkout.session.completed now writes accounts.stripe_customer_id ──
    sqlCalls.length = 0;

    // ── Delivery 2 (Stripe redelivery): failed row reclaimed, account exists → apply once → 200 ──
    mockClaimInboundEvent.mockResolvedValueOnce('claimed');
    mockRetrieveSubscription.mockResolvedValue({
      id: TEST_SUBSCRIPTION_ID,
      customer: TEST_CUSTOMER_ID,
      status: 'active',
      trial_end: null,
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_copilot_list_test', metadata: {}, unit_amount: 2900 },
          },
          {
            id: 'si_overage', quantity: 3, metadata: { billing_role: 'overage' },
            price: { id: 'price_copilot_overage_test', metadata: {}, unit_amount: 1500 },
          },
        ],
      },
    });
    sqlReturnQueue.push([{
      id: '019dc366-29ce-7000-a000-000000000001',
      stripe_subscription_id: TEST_SUBSCRIPTION_ID,
      active_offboarding_subscription_id: null,
    }]);
    sqlReturnQueue.push([]); // entitlement lock
    sqlReturnQueue.push([]); // billing lock
    sqlReturnQueue.push([{
      id: '019dc366-29ce-7000-a000-000000000001',
      subscription_tier: 'copilot',
      subscription_status: 'active',
      price_variant: 'list',
      base_price_cents: 2900,
      locations_paid: 0,
      locations_overage_price_cents: 1500,
      locations_included: 1,
      stripe_customer_id: TEST_CUSTOMER_ID,
      stripe_subscription_id: TEST_SUBSCRIPTION_ID,
      active_offboarding_subscription_id: null,
    }]);
    sqlReturnQueue.push([{ id: '019dc366-29ce-7000-a000-000000000001' }]);
    // Tier-only deprecated mirror projection.
    sqlReturnQueue.push(
      [{ id: '019dc366-29ce-7000-a000-0000000000bb' }],
      [],
      [{ subscription_tier: 'copilot' }],
      [],
    );
    sqlReturnQueue.push([]); // mark inbound event processed
    reply = mkReply();
    await handleStripeWebhook(mkRequest(), reply as any);
    expect(reply.status).toHaveBeenCalledWith(200);
    const applied = findTierApply();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.values).toContain('copilot');
    expect(applied[0]!.values).toContain(3);
    expect(findInboundUpdate('processed')).toBeDefined();
    expect(sqlReturnQueue).toHaveLength(0);

    // ── Delivery 3 (duplicate after success): claim='duplicate' → 200 no-op, NO second apply ──
    sqlCalls.length = 0;
    mockClaimInboundEvent.mockResolvedValueOnce('duplicate');
    reply = mkReply();
    await handleStripeWebhook(mkRequest(), reply as any);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(findTierApply()).toHaveLength(0);
  });
});
