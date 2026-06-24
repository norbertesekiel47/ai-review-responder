import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * customer.subscription.deleted — ALL cancellations route through the applier.
 *
 * After B1.1, BOTH trial and non-trial cancellations go through
 * applyStripeSubscriptionState (subscription mode). The applier maps Stripe
 * `canceled` → CANCELLED, clears trial_ends_at/past_due_at, mirrors all
 * businesses (NOTE-A), writes the audit row, and emits trial_cancelled ONLY
 * when leaving a trialing state. No inline UPDATE accounts remains.
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

  it('non-trial cancel (active → cancelled) routes through the applier, not inline SQL', async () => {
    sqlReturnQueue.push([{
      id: 'acct-1',
      subscription_status: 'active',
      stripe_subscription_id: 'sub_1',
      active_offboarding_subscription_id: null,
    }]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'cancelled',
      changed: true, activated: false, primaryBusinessId: null,
    });

    await processSubscriptionDeleted({ id: 'sub_1', customer: 'cus_1', status: 'canceled' } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'subscription', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
      expect.objectContaining({ id: 'sub_1', status: 'canceled' }),
    );
    const inlineCancel = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'cancelled'"),
    );
    expect(inlineCancel).toBeUndefined();
  });
});
