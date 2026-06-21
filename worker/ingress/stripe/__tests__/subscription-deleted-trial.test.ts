import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * customer.subscription.deleted — cancel during TRIAL (trialing → cancelled).
 *
 * When an owner cancels during the trial (via offboarding cancel_at_period_end →
 * Stripe deletes at trial_end), the account is `trialing`. The handler routes
 * the cancel through the single applier (subscription mode) so trial_ends_at is
 * cleared and trial_cancelled is emitted. Cancelling a NON-trial (active)
 * account keeps the unchanged inline cancel and does NOT emit trial_cancelled.
 */

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  mockApplyStripeSubscriptionState,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const mockSql: any = vi.fn((s: TemplateStringsArray, ...v: unknown[]) => {
    sqlCalls.push({ text: Array.from(s).join('?'), values: v });
    const queued = sqlReturnQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return Promise.resolve(Object.assign([], { count: 0 }));
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));
  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    mockApplyStripeSubscriptionState: vi.fn().mockResolvedValue({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'cancelled',
      changed: true, activated: false, primaryBusinessId: null,
    }),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../apply-subscription-state', () => ({
  applyStripeSubscriptionState: mockApplyStripeSubscriptionState,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

import { processSubscriptionDeleted } from '../subscription-deleted';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';

function deletedSub(): any {
  return { id: SUB_ID, customer: CUSTOMER_ID, status: 'canceled' };
}

function queueAccount(status: string) {
  sqlReturnQueue.push([{
    id: ACCOUNT_ID,
    subscription_status: status,
    stripe_subscription_id: SUB_ID,
    active_offboarding_subscription_id: null,
  }]);
}

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  mockApplyStripeSubscriptionState.mockClear();
});

describe('subscription.deleted — cancel during trial', () => {
  it('trialing account → applier cancels (emits trial_cancelled)', async () => {
    queueAccount('trialing');
    await processSubscriptionDeleted(deletedSub());

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    });
    expect(sub).toMatchObject({ status: 'canceled' });
  });

  it('active account → existing inline cancel, NOT the applier', async () => {
    queueAccount('active');
    await processSubscriptionDeleted(deletedSub());

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'cancelled'"),
    );
    expect(updateAcct).toBeDefined();
  });
});
