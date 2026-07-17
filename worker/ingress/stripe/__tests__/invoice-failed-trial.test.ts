import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * invoice.payment_failed — card-fail for trialing and active accounts.
 *
 * trialing → past_due: routed through the single applier (subscription mode),
 * which sets past_due + emits trial_payment_failed.
 *
 * active → past_due (QUALITY-OBS/B1.3): also routed through the applier in
 * subscription mode. The applier owns the status write + audit row.
 * The handler retains the recent-convert net-logic (trial_payment_failed emit)
 * AFTER the applier, guarded on transition.changed — the applier never emits
 * trial_payment_failed when fromStatus=active (only fires when fromStatus=trialing).
 */

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  mockApplyStripeSubscriptionState,
  mockEnqueueTrialPaymentFailed,
  mockRetrieve,
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
    mockRetrieve: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../apply-subscription-state', () => ({
  applyStripeSubscriptionStateUnderEntitlementLock: mockApplyStripeSubscriptionState,
}));
vi.mock('../../../../src/lib/analytics/trial-events', () => ({
  enqueueTrialPaymentFailed: mockEnqueueTrialPaymentFailed,
}));
vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return {
    ...actual,
    getStripe: () => ({ subscriptions: { retrieve: mockRetrieve } }),
  };
});
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

import { processInvoicePaymentFailed } from '../invoice-payment-failed';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';
const STATUS_READ_REQUEST_OPTIONS = { timeout: 20_000 };

function failedInvoice(): any {
  return { id: 'in_test', customer: CUSTOMER_ID, subscription: SUB_ID };
}

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  mockApplyStripeSubscriptionState.mockClear();
  mockEnqueueTrialPaymentFailed.mockClear();
  mockRetrieve.mockReset();
  mockRetrieve.mockImplementation(async (id: string) => ({
    id,
    customer: CUSTOMER_ID,
    status: 'past_due',
    trial_end: null,
  }));
});

describe('invoice.payment_failed — trial card fail', () => {
  it('trialing account → applier sets past_due (subscription mode)', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'trialing' }]);
    await processInvoicePaymentFailed(failedInvoice());

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, lockedAccountId, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(lockedAccountId).toBe(ACCOUNT_ID);
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    });
    expect(sub).toMatchObject({ status: 'past_due' });
  });

  it('active → past_due routes through the applier AND still emits trial_payment_failed for a recent convert', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts FOR UPDATE
    sqlReturnQueue.push([]);                                                 // pg_advisory_xact_lock
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'past_due',
      changed: true, activated: false, primaryBusinessId: null,
    });
    sqlReturnQueue.push([{ ok: true }]); // recentConvert EXISTS → true

    await processInvoicePaymentFailed({ id: 'in_1', customer: 'cus_1', subscription: 'sub_1' } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      { mode: 'subscription', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
      expect.objectContaining({ status: 'past_due' }),
    );
    expect(mockEnqueueTrialPaymentFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: 'acct-1', stripeSubscriptionId: 'sub_1' }),
    );
    const inlinePastDue = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'past_due'"),
    );
    expect(inlinePastDue).toBeUndefined();
  });

  it('active → past_due does NOT emit trial_payment_failed when there was no recent convert', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts FOR UPDATE
    sqlReturnQueue.push([]);                                                 // pg_advisory_xact_lock
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'past_due',
      changed: true, activated: false, primaryBusinessId: null,
    });
    sqlReturnQueue.push([{ ok: false }]); // recentConvert EXISTS → false

    await processInvoicePaymentFailed({ id: 'in_1', customer: 'cus_1', subscription: 'sub_1' } as any);
    expect(mockEnqueueTrialPaymentFailed).not.toHaveBeenCalled();
  });

  // Conversion-analytics accuracy: Stripe converts trialing→active BEFORE the
  // renewal charge, so a failed conversion lands on an 'active' account. If the
  // account converted from a trial in the last few days, emit trial_payment_failed
  // so net conversions = trial_converted − trial_payment_failed.
  // The applier is mocked here — the SQL queue only needs: SELECT account,
  // advisory lock, then the EXISTS query (no inline UPDATEs now that the
  // status write is owned by the applier).
  it('active account that just converted from a trial → also emits trial_payment_failed', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'active' }]); // SELECT account FOR UPDATE
    sqlReturnQueue.push([]);                                                   // pg_advisory_xact_lock
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'past_due',
      changed: true, activated: false, primaryBusinessId: null,
    });
    sqlReturnQueue.push([{ ok: true }]);                                      // EXISTS recent trial_converted
    await processInvoicePaymentFailed(failedInvoice());

    expect(mockEnqueueTrialPaymentFailed).toHaveBeenCalledTimes(1);
    expect(mockEnqueueTrialPaymentFailed).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: ACCOUNT_ID, stripeSubscriptionId: SUB_ID },
    );
  });

  it('active account on a normal renewal (no recent conversion) → does NOT emit trial_payment_failed', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'active' }]); // SELECT account FOR UPDATE
    sqlReturnQueue.push([]);                                                   // pg_advisory_xact_lock
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'past_due',
      changed: true, activated: false, primaryBusinessId: null,
    });
    sqlReturnQueue.push([{ ok: false }]);                                     // EXISTS → no recent conversion
    await processInvoicePaymentFailed(failedInvoice());

    expect(mockEnqueueTrialPaymentFailed).not.toHaveBeenCalled();
  });

  it('does NOT mark a sibling account past_due — resolves by (customer, subscription)', async () => {
    // Account row is resolved by (customer, subscription); a failed invoice for a
    // subscription NOT matching any account under this customer resolves nothing.
    sqlReturnQueue.push([]); // SELECT ... WHERE stripe_customer_id AND stripe_subscription_id → no row
    await processInvoicePaymentFailed({ id: 'in_1', customer: 'cus_shared', subscription: 'sub_B' } as any);
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('no-ops when the failed invoice has no subscription id (cannot attribute)', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // would be resolved + flipped in the old code
    await processInvoicePaymentFailed({ id: 'in_1', customer: 'cus_1' } as any); // no subscription
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('resolves the account by BOTH stripe_customer_id AND stripe_subscription_id', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // account resolve
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'past_due',
      changed: true, activated: false, primaryBusinessId: null,
    });
    sqlReturnQueue.push([{ ok: false }]); // recentConvert EXISTS
    await processInvoicePaymentFailed({ id: 'in_1', customer: 'cus_1', subscription: 'sub_1' } as any);
    const resolve = sqlCalls.find((c) => /\bFROM\s+accounts\b/i.test(c.text) && /stripe_customer_id/.test(c.text));
    expect(resolve).toBeDefined();
    expect(resolve!.text).toMatch(/stripe_subscription_id/);  // proves the lineage scoping
  });

  it('stale payment_failed delivery does not regress provider-current active', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID }], []);
    mockRetrieve.mockResolvedValueOnce({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'active',
      trial_end: null,
    });
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'active',
      changed: false, activated: false, primaryBusinessId: null,
    });

    await processInvoicePaymentFailed(failedInvoice());

    expect(mockRetrieve).toHaveBeenCalledWith(
      SUB_ID,
      {},
      STATUS_READ_REQUEST_OPTIONS,
    );
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      expect.objectContaining({ stripeSubscriptionId: SUB_ID }),
      expect.objectContaining({ status: 'active' }),
    );
    expect(mockEnqueueTrialPaymentFailed).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('reversed payment_failed delivery converges to provider-current cancellation', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID }], []);
    mockRetrieve.mockResolvedValueOnce({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'canceled',
      trial_end: null,
    });
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'active', toStatus: 'cancelled',
      changed: true, activated: false, primaryBusinessId: null,
    });

    await processInvoicePaymentFailed(failedInvoice());

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      expect.objectContaining({ stripeSubscriptionId: SUB_ID }),
      expect.objectContaining({ status: 'canceled' }),
    );
    expect(mockEnqueueTrialPaymentFailed).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
  });
});
