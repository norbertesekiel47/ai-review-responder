import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * subscription_status_changed audit logging (VAL-LOC-029/058): writeAccountAuditLog on
 * checkout activation, cancellation, past_due recovery, and the unchanged no-op.
 * Cross-cutting over checkout/subscription-deleted/invoice-paid.
 *
 * Split out of the former stripe-webhook-handlers.test.ts (issue #268). Mock graph
 * + queue helpers come from the shared ./helpers/stripe-webhook-harness, which
 * builds the Postgres.js mock from the canonical worker/__tests__/helpers/mock-sql.
 */

// ── Hoisted mocks (shared stripe-webhook harness) ──────────────────
const {
  mockSql,
  sqlCalls,
  mockClaimInboundEvent,
  mockConstructEvent,
  mockWriteAccountAuditLog,
  resetStripeWebhookMocks,
  queueInvoicePaid,
  queueSubscriptionDeleted,
  queueCheckoutActivate,
} = await vi.hoisted(async () => {
  const { createStripeWebhookHarness } = await import('./helpers/stripe-webhook-harness');
  return createStripeWebhookHarness();
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));
vi.mock('../shared', () => ({ claimInboundEvent: mockClaimInboundEvent }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));
vi.mock('stripe', () => ({
  default: class FakeStripe {
    webhooks = { constructEvent: mockConstructEvent };
    subscriptions = {
      retrieve: vi.fn().mockResolvedValue({
        id: 'sub_test_456',
        customer: 'cus_test_123',
        status: 'active',
        trial_end: null,
        items: {
          data: [{
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_copilot_list_test', metadata: {}, unit_amount: 2900 },
          }],
        },
      }),
    };
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
});

describe('subscription_status_changed audit logging', () => {
  it('VAL-LOC-029: logs subscription_status_changed on checkout activation (pending_payment → active)', async () => {
    // After B1.4, the audit write goes through the applier → writeAccountAuditLog
    // (mocked as mockWriteAccountAuditLog), NOT a raw SQL INSERT. Assert via the mock.
    mockConstructEvent.mockReturnValue({
      id: 'evt_audit_activate',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_audit',
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

    // Audit goes through the mocked writeAccountAuditLog (same as subscription.deleted,
    // invoice.paid — all other handlers already use the applier's audit path).
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'pending_payment', toStatus: 'active' },
      }),
    );
  });

  it('VAL-LOC-058: logs subscription_status_changed on cancellation (active → cancelled)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_audit_cancel',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID, status: 'canceled' } },
    });

    queueSubscriptionDeleted({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'active', toStatus: 'cancelled' },
      }),
    );
  });

  it('logs subscription_status_changed on past_due recovery', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_audit_recover',
      type: 'invoice.paid',
      data: { object: { id: 'in_audit_recover', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaid({ status: 'past_due' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      mockSql,
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'past_due', toStatus: 'active' },
      }),
    );
  });

  it('does not log audit when status unchanged (idempotent no-op)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_audit_noop',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID, status: 'canceled' } },
    });

    queueSubscriptionDeleted({ status: 'cancelled' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // No audit INSERT for cancelled → cancelled (no transition)
    const auditInsert = sqlCalls.find(
      (c) => /\bINSERT INTO account_audit_log\b/.test(c.text),
    );
    expect(auditInsert).toBeUndefined();
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
