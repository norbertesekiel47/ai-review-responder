import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * invoice.payment_failed handler (worker/ingress/stripe/invoice-payment-failed.ts):
 * active -> past_due, idempotent re-delivery, missing-customer skip, advisory lock.
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
  queueInvoicePaymentFailed,
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

describe('invoice.payment_failed — sets account to past_due', () => {
  it('VAL-BILLING-012: active → past_due', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_failed_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_1', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaymentFailed({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('past_due'),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NOW\(\)/i);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: TEST_ACCOUNT_ID,
        eventType: 'subscription_status_changed',
        entityType: 'account',
        entityId: TEST_ACCOUNT_ID,
        payload: { fromStatus: 'active', toStatus: 'past_due' },
      }),
      mockSql,
    );
  });

  it('already past_due → no-op (idempotent)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_failed_dup',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_dup', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaymentFailed({ status: 'past_due' });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // No accounts UPDATE should fire since status is already past_due
    const updateAcct = sqlCalls.filter(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes('past_due') && !c.text.includes('inbound_events'),
    );
    expect(updateAcct).toEqual([]);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    // Log should indicate already past_due
    const logText = consoleSpy.mock.calls.flat().join(' ');
    expect(logText).toMatch(/already/);

    consoleSpy.mockRestore();
  });

  it('missing customer → warns and skips', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_failed_no_cust',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_no_cust', customer: null } },
    });

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    const warnedText = consoleSpy.mock.calls.flat().join(' ');
    expect(warnedText).toMatch(/missing customer/);

    consoleSpy.mockRestore();
  });

  it('uses advisory lock before status update (VAL-BILLING-062)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_failed_lock',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_lock', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaymentFailed({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const lockIdx = sqlCalls.findIndex((c) => c.text.includes('pg_advisory_xact_lock'));
    const updateIdx = sqlCalls.findIndex(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && !c.text.includes('inbound_events'),
    );

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
  });
});
