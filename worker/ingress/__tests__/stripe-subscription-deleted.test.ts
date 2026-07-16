import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { SubscriptionStatus } from '../../../src/lib/shared/subscription-status';

/**
 * customer.subscription.deleted handler (worker/ingress/stripe/subscription-deleted.ts):
 * sets cancelled regardless of prior status, idempotent no-op, missing-customer skip,
 * advisory lock, stale / active-offboarding subscription guards.
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
  queueSubscriptionDeleted,
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

function isStatusUpdate(
  call: (typeof sqlCalls)[number],
  table: 'accounts' | 'businesses',
  status: string,
): boolean {
  const updatesTable = table === 'accounts'
    ? /\bUPDATE\s+accounts\b/.test(call.text)
    : /\bUPDATE\s+businesses\b/.test(call.text);
  return updatesTable
    && !call.text.includes('inbound_events')
    && call.values.includes(status);
}

beforeEach(() => {
  resetStripeWebhookMocks();
});

describe('customer.subscription.deleted — sets account to cancelled', () => {
  it('VAL-BILLING-015: sets cancelled regardless of prior status', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID, status: 'canceled' } },
    });

    queueSubscriptionDeleted({ status: 'active' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);

    const updateAcct = sqlCalls.find(
      (call) => isStatusUpdate(call, 'accounts', SubscriptionStatus.CANCELLED),
    );
    expect(updateAcct).toBeDefined();
    expect(updateAcct!.text).toMatch(/cancelled_at\s*=\s*NOW\(\)/i);
    expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NULL/i);
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

  it('cancelled → cancelled is idempotent (no UPDATE fires)', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_dup',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID, status: 'canceled' } },
    });

    queueSubscriptionDeleted({ status: 'cancelled' });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    // The applier's isAllowedTransition(cancelled→cancelled) returns false,
    // so no UPDATE fires. Idempotency is now enforced by the applier's
    // transition table, not by the old inline if-guard.
    const updateAcct = sqlCalls.filter(
      (call) => isStatusUpdate(call, 'accounts', SubscriptionStatus.CANCELLED),
    );
    expect(updateAcct).toEqual([]);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('missing customer → warns and skips', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_no_cust',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: null } },
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
      id: 'evt_sub_deleted_lock',
      type: 'customer.subscription.deleted',
      data: { object: { id: TEST_SUBSCRIPTION_ID, customer: TEST_CUSTOMER_ID, status: 'canceled' } },
    });

    queueSubscriptionDeleted({ status: 'active' });

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

  it('ignores stale old-subscription deletes after reactivation/new checkout', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_stale_old_sub',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_old_cancelled', customer: TEST_CUSTOMER_ID, status: 'canceled' } },
    });

    queueSubscriptionDeleted({
      status: 'active',
      stripeSubscriptionId: 'sub_new_reactivated',
      activeOffboardingSubscriptionId: null,
    });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    expect(
      sqlCalls.some((call) => isStatusUpdate(call, 'accounts', SubscriptionStatus.CANCELLED)),
    ).toBe(false);
    expect(
      sqlCalls.some((call) => isStatusUpdate(call, 'businesses', SubscriptionStatus.CANCELLED)),
    ).toBe(false);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });

  it('no-ops active offboarding subscription snapshot deletes when account has a newer subscription', async () => {
    mockConstructEvent.mockReturnValue({
      id: 'evt_sub_deleted_active_offboarding_sub',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_old_tearing_down', customer: TEST_CUSTOMER_ID, status: 'canceled' } },
    });

    queueSubscriptionDeleted({
      status: 'active',
      stripeSubscriptionId: 'sub_new_reactivated',
      activeOffboardingSubscriptionId: 'sub_old_tearing_down',
    });

    const { status, send } = mkReply();
    await handleStripeWebhook(mkRequest(), { status, send } as any);

    expect(status).toHaveBeenCalledWith(200);
    expect(
      sqlCalls.some((call) => isStatusUpdate(call, 'accounts', SubscriptionStatus.CANCELLED)),
    ).toBe(false);
    expect(
      sqlCalls.some((call) => isStatusUpdate(call, 'businesses', SubscriptionStatus.CANCELLED)),
    ).toBe(false);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
  });
});
