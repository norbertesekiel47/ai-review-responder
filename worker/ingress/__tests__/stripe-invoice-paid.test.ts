import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';

/**
 * invoice.paid handler (worker/ingress/stripe/invoice-paid.ts):
 * past_due -> active recovery, already-active no-op, overage-recompute outbox,
 * missing-customer skip, advisory lock.
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

function isAccountStatusUpdate(
  call: (typeof sqlCalls)[number],
  status: string,
): boolean {
  return /\bUPDATE\s+accounts\b/.test(call.text)
    && !call.text.includes('inbound_events')
    && call.values.includes(status);
}

beforeEach(() => {
  resetStripeWebhookMocks();
});

describe('invoice.paid — active recovery from past_due', () => {
  it('VAL-BILLING-013: past_due → active', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_1',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_1', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaid({ status: 'past_due' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (call) => isAccountStatusUpdate(call, SubscriptionStatus.ACTIVE),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NULL/i);
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

  it('VAL-BILLING-014: already active → no-op', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_active',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_active', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaid({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // No accounts UPDATE should fire since status is already active
    const updateAcct = sqlCalls.filter(
      (call) => isAccountStatusUpdate(call, SubscriptionStatus.ACTIVE),
    );
    expect(updateAcct).toEqual([]);
  });

  it('VAL-BILLING-D3a: past_due → active recovery inserts one update_stripe_overage_quantity outbox row', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_overage_enqueue',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_overage', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaid({ status: 'past_due' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // Topic is an interpolated value — in values array; aggregate_type/'pending'
    // are SQL string literals — in the text.
    const overageInserts = sqlCalls.filter(
      (c) => c.text.includes('INSERT INTO job_outbox') && c.values.includes('update_stripe_overage_quantity'),
    );
    expect(overageInserts).toHaveLength(1);
    const insert = overageInserts[0]!;
    expect(insert.text).toContain("'account'");   // aggregate_type — SQL literal
    expect(insert.values).toContain('pending');   // status — bound by enqueueStripeOverageRecompute
    expect(insert.values).toContain(TEST_ACCOUNT_ID); // aggregate_id — interpolated
  });

  it('VAL-BILLING-D3b: already-active account (VAL-BILLING-014 no-op) does NOT insert overage outbox row', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_noop_overage',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_noop_overage', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaid({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    // Topic is an interpolated value — check values array.
    const overageInserts = sqlCalls.filter(
      (c) => c.text.includes('INSERT INTO job_outbox') && c.values.includes('update_stripe_overage_quantity'),
    );
    expect(overageInserts).toHaveLength(0);
  });

  it('missing customer → warns and skips', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_inv_paid_no_cust',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_no_cust', customer: null } },
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
      id: 'evt_inv_paid_lock',
      type: 'invoice.paid',
      data: { object: { id: 'in_paid_lock', customer: TEST_CUSTOMER_ID, subscription: TEST_SUBSCRIPTION_ID } },
    });

    queueInvoicePaid({ status: 'past_due' });

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
