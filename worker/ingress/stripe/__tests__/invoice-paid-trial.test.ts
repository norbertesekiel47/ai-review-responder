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
  mockMaybeEnqueueBackfillResume,
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
    mockMaybeEnqueueBackfillResume: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../../src/lib/audit/log', () => ({ writeAccountAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueStripeOverageRecompute: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../apply-subscription-state', () => ({
  applyStripeSubscriptionState: mockApplyStripeSubscriptionState,
}));
vi.mock('../shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared')>();
  return {
    ...actual,
    getStripe: () => ({ subscriptions: { retrieve: mockRetrieve } }),
    maybeEnqueueBackfillResume: mockMaybeEnqueueBackfillResume,
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
  mockMaybeEnqueueBackfillResume.mockClear();
});

describe('invoice.paid — trial conversion (FIX 4)', () => {
  it('trialing account whose Stripe sub is now active → converts via applier (subscription mode)', async () => {
    // accounts SELECT FOR UPDATE returns a trialing account.
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'trialing' }]);
    mockRetrieve.mockResolvedValue({ id: SUB_ID, customer: CUSTOMER_ID, status: 'active', trial_end: null });

    await processInvoicePaid(invoice());

    expect(mockRetrieve).toHaveBeenCalledWith(SUB_ID);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: CUSTOMER_ID,
      stripeSubscriptionId: SUB_ID,
    });
    expect(sub).toMatchObject({ status: 'active' });
  });

  it('trialing account whose Stripe sub is STILL trialing ($0 trial-start invoice) → no early conversion (applier is a no-op)', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'trialing' }]);
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
    const [, , sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(sub).toMatchObject({ status: 'trialing' });
    // No inline past_due→active UPDATE either.
    const updateAcct = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(updateAcct).toBeUndefined();
  });

  it('past_due account → routes through applier (checkout/by-accountId mode), NO Stripe retrieve', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'past_due' }]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    });

    await processInvoicePaid(invoice());

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'checkout', accountId: ACCOUNT_ID },
      expect.objectContaining({ status: 'active' }),
    );
    const inlineRecover = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(inlineRecover).toBeUndefined();
  });

  it('past_due → active recovery routes through the applier (checkout/by-accountId mode)', async () => {
    sqlReturnQueue.push([{ id: 'acct-1', subscription_status: 'past_due' }]); // accounts FOR UPDATE
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: 'biz-1',
    });

    await processInvoicePaid({ id: 'in_1', customer: 'cus_1',
      lines: { data: [] }, subscription: 'sub_1' } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'checkout', accountId: 'acct-1' },
      expect.objectContaining({ id: 'sub_1', status: 'active' }),
    );
    const inlineRecover = sqlCalls.find(
      (c) => /\bUPDATE\s+accounts\b/.test(c.text) && c.text.includes("'active'"),
    );
    expect(inlineRecover).toBeUndefined();
  });

  it('recovery synth id prefers the account\'s existing stripe_subscription_id (never passes empty string)', async () => {
    // Account already has its own subscription id; the invoice carries a
    // DIFFERENT one. Precedence must pick the account's existing id so the
    // applier's COALESCE(stripe_subscription_id, id) stays a strict no-op.
    sqlReturnQueue.push([
      { id: ACCOUNT_ID, subscription_status: 'past_due', stripe_subscription_id: 'sub_existing' },
    ]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    });

    await processInvoicePaid({ id: 'in_1', customer: CUSTOMER_ID,
      lines: { data: [] }, subscription: 'sub_from_invoice' } as any);

    const [, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({ mode: 'checkout', accountId: ACCOUNT_ID });
    expect(sub).toMatchObject({ id: 'sub_existing', status: 'active' });
    expect(sub.id).not.toBe('');
  });

  it('recovery synth id falls back to the invoice subscription id when the account has none', async () => {
    // Pathological: account row missing stripe_subscription_id. The OLD inline
    // recovery wrote no Stripe ids at all; the new path must NOT write '' (which
    // would make the account unresolvable). Fall back to the invoice's real id.
    sqlReturnQueue.push([
      { id: ACCOUNT_ID, subscription_status: 'past_due', stripe_subscription_id: null },
    ]);
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'past_due', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    });

    await processInvoicePaid({ id: 'in_1', customer: CUSTOMER_ID,
      lines: { data: [] }, subscription: 'sub_from_invoice' } as any);

    const [, , sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(sub).toMatchObject({ id: 'sub_from_invoice', status: 'active' });
    expect(sub.id).not.toBe('');
  });

  it('active account → no-op, NO Stripe retrieve', async () => {
    sqlReturnQueue.push([{ id: ACCOUNT_ID, subscription_status: 'active' }]);

    await processInvoicePaid(invoice());

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });
});
