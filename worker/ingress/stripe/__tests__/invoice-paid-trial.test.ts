import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * invoice.paid — TRIAL conversion (second convert path; PLAN.md §4.12 / FIX 4).
 *
 * invoice.paid is a SECOND, redundant convert path independent of
 * customer.subscription.updated. When the loaded account is `trialing`, the
 * handler retrieves the subscription (pinned getStripe()) and routes through the
 * SINGLE applier (subscription mode). The applier converts trialing→active ONLY
 * when the retrieved Stripe status is `active`, so:
 *   - a real trial-end invoice (sub now active) → converts.
 *   - the $0 trial-START invoice (sub still trialing) → safe no-op.
 * The extra retrieve is gated to trialing accounts only; the past_due→active
 * recovery path is unchanged and does NOT retrieve.
 */

const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  mockApplyStripeSubscriptionState,
  mockRetrieve,
  mockResumePrimaryBusinessBackfill,
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
    mockRetrieve: vi.fn(),
    mockResumePrimaryBusinessBackfill: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueStripeOverageRecompute: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../apply-subscription-state', () => ({
  applyStripeSubscriptionStateUnderEntitlementLock: mockApplyStripeSubscriptionState,
}));
vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return {
    ...actual,
    getStripe: () => ({ subscriptions: { retrieve: mockRetrieve } }),
    resumePrimaryBusinessBackfill: mockResumePrimaryBusinessBackfill,
  };
});
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

import { processInvoicePaid } from '../invoice-paid';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';

function invoice(): any {
  return { id: 'in_test', customer: CUSTOMER_ID, subscription: SUB_ID };
}

beforeEach(() => {
  sqlReturnQueue.length = 0;
  sqlCalls.length = 0;
  mockApplyStripeSubscriptionState.mockClear();
  mockRetrieve.mockReset();
  mockRetrieve.mockImplementation(async (id: string) => ({
    id,
    customer: CUSTOMER_ID,
    status: 'active',
    trial_end: null,
  }));
  mockResumePrimaryBusinessBackfill.mockClear();
});

describe('invoice.paid — trial conversion (FIX 4)', () => {
  it('trialing account whose Stripe sub is now active → converts via applier (subscription mode)', async () => {
    // accounts SELECT FOR UPDATE returns a trialing account whose current sub matches the invoice.
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'trialing', stripe_subscription_id: SUB_ID }]);
    mockRetrieve.mockResolvedValue({ id: SUB_ID, customer: CUSTOMER_ID, status: 'active', trial_end: null });

    await processInvoicePaid(invoice());

    expect(mockRetrieve).toHaveBeenCalledWith(SUB_ID);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, lockedAccountId, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(lockedAccountId).toBe(ACCOUNT_ID);
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    });
    expect(sub).toMatchObject({ status: 'active' });
  });

  it('trialing account whose Stripe sub is STILL trialing ($0 trial-start invoice) → no early conversion (applier is a no-op)', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'trialing', stripe_subscription_id: SUB_ID }]);
    mockRetrieve.mockResolvedValue({ id: SUB_ID, customer: CUSTOMER_ID, status: 'trialing', trial_end: 9999999999 });
    // The applier returns changed:false for a still-trialing sub (transition
    // table: trialing→trialing is a no-op). Model that.
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'trialing',
      changed: false, activated: false, primaryBusinessId: null,
    });

    await processInvoicePaid(invoice());

    // The applier is called (the conversion decision lives there) but it does
    // NOT convert — Stripe status is still trialing.
    expect(mockRetrieve).toHaveBeenCalledWith(SUB_ID);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, , , sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(sub).toMatchObject({ status: 'trialing' });
    // No inline past_due→active UPDATE either.
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(updateAcct).toBeUndefined();
  });

  it('past_due account retrieves provider-current state before the under-entitlement applier', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'past_due', stripe_subscription_id: SUB_ID }]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    });

    await processInvoicePaid(invoice());

    expect(mockRetrieve).toHaveBeenCalledWith(SUB_ID);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      { mode: 'subscription', stripeCustomerId: CUSTOMER_ID, stripeSubscriptionId: SUB_ID },
      expect.objectContaining({ status: 'active' }),
    );
    const inlineRecover = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(inlineRecover).toBeUndefined();
  });

  it('past_due → active recovery routes through the lineage-scoped applier', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'past_due', stripe_subscription_id: 'sub_1' }]); // accounts FOR UPDATE
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: 'biz-1',
    });

    await processInvoicePaid({ id: 'in_1', customer: 'cus_1',
      lines: { data: [] }, subscription: 'sub_1' } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      { mode: 'subscription', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1' },
      expect.objectContaining({ id: 'sub_1', status: 'active' }),
    );
    const inlineRecover = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(inlineRecover).toBeUndefined();
  });

  it('reversed invoice.paid delivery converges to provider-current cancellation without activation', async () => {
    sqlReturnQueue.push([{
      id: ACCOUNT_ID,
      subscription_status: 'past_due',
      stripe_subscription_id: SUB_ID,
    }]);
    mockRetrieve.mockResolvedValueOnce({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'canceled',
      trial_end: null,
    });
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'cancelled',
      changed: true, activated: false, primaryBusinessId: null,
    });

    await processInvoicePaid(invoice());

    expect(mockRetrieve).toHaveBeenCalledWith(SUB_ID);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      ACCOUNT_ID,
      expect.objectContaining({ stripeSubscriptionId: SUB_ID }),
      expect.objectContaining({ status: 'canceled' }),
    );
    expect(mockResumePrimaryBusinessBackfill).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('recovery passes the invoice subscription id (which equals the matched account\'s) — never an empty string', async () => {
    // Subscription-lineage scope: recovery fires only when the account's CURRENT
    // subscription equals the invoice's. The applier therefore always receives the
    // invoice's real subscription id (== the account's), never a synth '' fallback.
    sqlReturnQueue.push([
      { id: ACCOUNT_ID, subscription_status: 'past_due', stripe_subscription_id: 'sub_matched' },
    ]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    });

    await processInvoicePaid({ id: 'in_1', customer: CUSTOMER_ID,
      lines: { data: [] }, subscription: 'sub_matched' } as any);

    const [, lockedAccountId, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(lockedAccountId).toBe(ACCOUNT_ID);
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: 'sub_matched',
    });
    expect(sub).toMatchObject({ id: 'sub_matched', status: 'active' });
    expect(sub.id).not.toBe('');
  });

  it('does NOT recover a past_due account whose subscription differs from the invoice (lineage scope)', async () => {
    // Account's current subscription is 'sub_existing'; the invoice paid is for a
    // DIFFERENT subscription. With subscription-lineage scope this is NOT the
    // account's lineage → no recovery, no applier call (the old ?? '' synth path
    // would have wrongly reactivated it).
    sqlReturnQueue.push([]);

    await processInvoicePaid({ id: 'in_1', customer: CUSTOMER_ID,
      lines: { data: [] }, subscription: 'sub_from_invoice' } as any);

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('does NOT recover a past_due account missing a stripe_subscription_id (cannot attribute lineage)', async () => {
    // Pathological: account row missing stripe_subscription_id. A null sub can
    // never equal the invoice's subscription, so it is not lineage-attributable
    // and is left for the reconcile poller — never recovered by customer alone.
    sqlReturnQueue.push([]);

    await processInvoicePaid({ id: 'in_1', customer: CUSTOMER_ID,
      lines: { data: [] }, subscription: 'sub_from_invoice' } as any);

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('does not activate pending_payment with a null subscription id from an older invoice lineage', async () => {
    // In production the pending account exists under this customer with
    // stripe_subscription_id NULL. The exact customer+subscription lookup must
    // therefore return no row rather than adopting the invoice subscription.
    sqlReturnQueue.push([]);

    await processInvoicePaid({
      id: 'in_stale_checkout',
      customer: CUSTOMER_ID,
      subscription: 'sub_older_checkout',
      lines: { data: [] },
    } as any);

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toMatch(/stripe_customer_id[\s\S]*stripe_subscription_id/);
    expect(sqlCalls[0]!.values).toEqual(
      expect.arrayContaining([CUSTOMER_ID, 'sub_older_checkout']),
    );
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(mockResumePrimaryBusinessBackfill).not.toHaveBeenCalled();
    expect(sqlReturnQueue).toHaveLength(0);
  });

  it('active account → no-op, NO Stripe retrieve', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'active' }]);

    await processInvoicePaid(invoice());

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('does NOT recover a sibling past_due account whose subscription differs from the invoice', async () => {
    // Customer cus_shared has TWO accounts: acct-A (sub_A, past_due) and acct-B
    // (sub_B, past_due). The invoice paid is for sub_A → only acct-A recovers.
    sqlReturnQueue.push([
      { id: 'acct-A', subscription_status: 'past_due', stripe_subscription_id: 'sub_A' },
    ]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: 'biz-A',
    });
    await processInvoicePaid({ id: 'in_1', customer: 'cus_shared', lines: { data: [] }, subscription: 'sub_A' } as any);
    // Applier called exactly once for the matching subscription lineage.
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      'acct-A',
      { mode: 'subscription', stripeCustomerId: 'cus_shared', stripeSubscriptionId: 'sub_A' },
      expect.objectContaining({ id: 'sub_A', status: 'active' }),
    );
  });

  it('does NOT recover by customer alone when the invoice has no subscription id', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'past_due', stripe_subscription_id: 'sub_1' }]);
    await processInvoicePaid({ id: 'in_1', customer: 'cus_1', lines: { data: [] } } as any); // no subscription
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('converts ONLY the trialing account whose subscription matches the invoice (not a sibling under the same customer)', async () => {
    // cus_shared has TWO trialing accounts: acct-A (sub_A) and acct-B (sub_B). Invoice is for sub_A.
    sqlReturnQueue.push([
      { id: 'acct-A', subscription_status: 'trialing', stripe_subscription_id: 'sub_A' },
    ]);
    // getStripe().subscriptions.retrieve(sub_A) → active (conversion)
    mockRetrieve.mockResolvedValueOnce({ id: 'sub_A', customer: 'cus_shared', status: 'active', trial_end: null });
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: 'biz-A',
    });
    await processInvoicePaid({ id: 'in_1', customer: 'cus_shared', lines: { data: [] }, subscription: 'sub_A' } as any);
    // applier called exactly ONCE (for the matching account), never for acct-B
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
  });

  it('does not attempt a trial convert when no trialing account matches the invoice subscription', async () => {
    sqlReturnQueue.push([]);
    await processInvoicePaid({ id: 'in_1', customer: 'cus_shared', lines: { data: [] }, subscription: 'sub_A' } as any);
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });
});
