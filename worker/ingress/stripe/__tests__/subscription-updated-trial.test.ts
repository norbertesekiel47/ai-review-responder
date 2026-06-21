import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * customer.subscription.updated — TRIAL conversion (trialing → active).
 *
 * Stripe emits customer.subscription.updated with status='active' when a trial
 * converts. When the account is currently `trialing` and the event's sub status
 * is `active`, the handler converts via the single applier (subscription mode)
 * inside the same tx, then runs the unchanged tier/locations sync. The $0
 * trial-start invoice.paid does NOT convert (the conversion gate is the
 * subscription's `active` status, asserted here). Non-trialing accounts are
 * unaffected.
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
      accountResolved: true, fromStatus: 'trialing', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    }),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../apply-subscription-state', () => ({
  applyStripeSubscriptionState: mockApplyStripeSubscriptionState,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

const PRICE_ENV = {
  STRIPE_PRICE_STANDARD: 'price_standard_test',
  STRIPE_PRICE_STANDARD_OVERAGE: 'price_standard_overage_test',
};
for (const [k, v] of Object.entries(PRICE_ENV)) process.env[k] = v;

import { processSubscriptionUpdated } from '../subscription-updated';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';

function updatedSub(status: string): any {
  return {
    id: SUB_ID,
    customer: CUSTOMER_ID,
    status,
    items: { data: [{ price: { id: 'price_standard_test' }, quantity: 1 }] },
  };
}

function queueAccount(status: string) {
  sqlReturnQueue.push([{
    id: ACCOUNT_ID,
    subscription_tier: 'standard',
    subscription_status: status,
    locations_paid: 0,
    locations_overage_price_cents: 2500,
    stripe_subscription_id: SUB_ID,
    active_offboarding_subscription_id: null,
  }]);
}

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  mockApplyStripeSubscriptionState.mockClear();
});

describe('subscription.updated — trial conversion', () => {
  it('trialing account + active sub → applier converts (subscription mode)', async () => {
    queueAccount('trialing');
    await processSubscriptionUpdated(updatedSub('active'));

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    });
    expect(sub).toMatchObject({ status: 'active' });
  });

  it('trialing account + still-trialing sub → NO conversion (no applier call)', async () => {
    queueAccount('trialing');
    await processSubscriptionUpdated(updatedSub('trialing'));
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('active account + active sub → NO conversion (already active)', async () => {
    queueAccount('active');
    await processSubscriptionUpdated(updatedSub('active'));
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });
});
