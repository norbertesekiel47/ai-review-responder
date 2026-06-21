import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * invoice.payment_failed — TRIAL card-fail (trialing → past_due).
 *
 * When a trial's first charge fails at trial end, the account is `trialing`.
 * The handler routes trialing→past_due through the single applier (subscription
 * mode), which sets past_due + emits trial_payment_failed. The existing
 * active→past_due path is unchanged (and does NOT call the applier).
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
      accountResolved: true, fromStatus: 'trialing', toStatus: 'past_due',
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

import { processInvoicePaymentFailed } from '../invoice-payment-failed';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';

function failedInvoice(): any {
  return { id: 'in_test', customer: CUSTOMER_ID, subscription: SUB_ID };
}

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  mockApplyStripeSubscriptionState.mockClear();
});

describe('invoice.payment_failed — trial card fail', () => {
  it('trialing account → applier sets past_due (subscription mode)', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'trialing' }]);
    await processInvoicePaymentFailed(failedInvoice());

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    });
    expect(sub).toMatchObject({ status: 'past_due' });
  });

  it('active account → existing inline path, NOT the applier', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'active' }]);
    await processInvoicePaymentFailed(failedInvoice());

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'past_due'"),
    );
    expect(updateAcct).toBeDefined();
  });
});
