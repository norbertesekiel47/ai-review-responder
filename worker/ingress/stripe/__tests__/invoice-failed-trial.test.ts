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
  mockEnqueueTrialPaymentFailed,
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
    mockEnqueueTrialPaymentFailed: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../apply-subscription-state', () => ({
  applyStripeSubscriptionState: mockApplyStripeSubscriptionState,
}));
vi.mock('../../../../src/lib/analytics/trial-events', () => ({
  enqueueTrialPaymentFailed: mockEnqueueTrialPaymentFailed,
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
  mockEnqueueTrialPaymentFailed.mockClear();
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

  // Conversion-analytics accuracy: Stripe converts trialing→active BEFORE the
  // renewal charge, so a failed conversion lands on an 'active' account. If the
  // account converted from a trial in the last few days, emit trial_payment_failed
  // so net conversions = trial_converted − trial_payment_failed.
  it('active account that just converted from a trial → also emits trial_payment_failed', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'active' }]); // SELECT account
    sqlReturnQueue.push([]);                                                  // advisory lock
    sqlReturnQueue.push([]);                                                  // UPDATE accounts
    sqlReturnQueue.push([]);                                                  // UPDATE businesses
    sqlReturnQueue.push([{ ok: true }]);                                      // EXISTS recent trial_converted
    await processInvoicePaymentFailed(failedInvoice());

    expect(mockEnqueueTrialPaymentFailed).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTrialPaymentFailed).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID },
    );
  });

  it('active account on a normal renewal (no recent conversion) → does NOT emit trial_payment_failed', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'active' }]); // SELECT account
    sqlReturnQueue.push([]);                                                  // advisory lock
    sqlReturnQueue.push([]);                                                  // UPDATE accounts
    sqlReturnQueue.push([]);                                                  // UPDATE businesses
    sqlReturnQueue.push([{ ok: false }]);                                     // EXISTS → no recent conversion
    await processInvoicePaymentFailed(failedInvoice());

    expect(mockEnqueueTrialPaymentFailed).not.toHaveBeenCalled();
  });
});
