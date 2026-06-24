import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * checkout.session.completed — TRIAL start path.
 *
 * When a Checkout Session was created with subscription_data.trial_period_days,
 * it charges $0 now (amount_total === 0) and the retrieved subscription is
 * status='trialing' with a future trial_end. Stripe reports payment_status as
 * EITHER 'paid' (the real card-up-front case with payment_method_collection
 * 'always' — the $0 subscription_create invoice auto-finalizes 'paid') OR
 * 'no_payment_required'. The handler gates on the $0 signal (NOT payment_status —
 * gating on 'no_payment_required' misfiled every real trial as 'active'; caught by
 * staging E2E 2026-06-22), retrieves + verifies the subscription, and routes the
 * trial-start through applyStripeSubscriptionState in checkout mode. The normal
 * paid (amount_total>0) path is unchanged and takes no extra retrieve.
 */

const {
  mockSql,
  mockApplyStripeSubscriptionState,
  mockMaybeEnqueueBackfillResume,
  mockRetrieve,
} = vi.hoisted(() => {
  // Default: the account-resolution SELECT (`SELECT id FROM accounts WHERE id=...`)
  // returns the account so refId resolves; all other queries (advisory lock, etc.)
  // are harmless empties. The applier itself is mocked, so its internal queries
  // never run here.
  const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
  const mockSql: any = vi.fn((s: TemplateStringsArray) => {
    const text = Array.from(s).join('?');
    if (/SELECT\s+id\s+FROM\s+accounts/i.test(text)) {
      return Promise.resolve([{ id: ACCOUNT_ID }]);
    }
    return Promise.resolve(Object.assign([], { count: 0 }));
  });
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));
  return {
    mockSql,
    mockApplyStripeSubscriptionState: vi.fn(),
    mockMaybeEnqueueBackfillResume: vi.fn().mockResolvedValue(undefined),
    mockRetrieve: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../apply-subscription-state', () => ({
  applyStripeSubscriptionState: mockApplyStripeSubscriptionState,
}));
vi.mock('../shared', async () => {
  const actual = await vi.importActual<typeof import('../shared')>('../shared');
  return {
    ...actual,
    maybeEnqueueBackfillResume: mockMaybeEnqueueBackfillResume,
    getStripe: () => ({ subscriptions: { retrieve: mockRetrieve } }),
  };
});
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueStripeOverageRecompute: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

import { processCheckoutSessionCompleted } from '../checkout-completed';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const PRIMARY_BIZ = '019dc366-29ce-7000-a000-0000000000bb';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';
const FUTURE_TRIAL_END = Math.floor(Date.now() / 1000) + 30 * 86400;

// Default mirrors the REAL card-up-front trial session: $0 charged now, but
// payment_status='paid' (payment_method_collection:'always' finalizes the $0
// subscription_create invoice as paid). This is the shape that broke production.
function trialSession(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'cs_trial',
    mode: 'subscription',
    payment_status: 'paid',
    amount_total: 0,
    client_reference_id: ACCOUNT_ID,
    customer: CUSTOMER_ID,
    subscription: SUB_ID,
    ...overrides,
  };
}

beforeEach(() => {
  mockApplyStripeSubscriptionState.mockReset();
  mockApplyStripeSubscriptionState.mockResolvedValue({
    accountResolved: true,
    fromStatus: 'pending_payment',
    toStatus: 'trialing',
    changed: true,
    activated: true,
    primaryBusinessId: PRIMARY_BIZ,
  });
  mockMaybeEnqueueBackfillResume.mockClear();
  mockRetrieve.mockReset();
});

describe('checkout.session.completed — paid activation', () => {
  it('paid activation (pending_payment → active) routes through the applier in checkout mode', async () => {
    // amount_total > 0 and payment_status = 'paid' → skips trial-start branch entirely
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true,
      fromStatus: 'pending_payment',
      toStatus: 'active',
      changed: true,
      activated: true,
      primaryBusinessId: PRIMARY_BIZ,
    });

    await processCheckoutSessionCompleted({
      client_reference_id: ACCOUNT_ID,
      mode: 'subscription',
      payment_status: 'paid',
      amount_total: 7900,
      customer: CUSTOMER_ID,
      subscription: SUB_ID,
    } as any);

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'checkout', accountId: ACCOUNT_ID },
      expect.objectContaining({ id: SUB_ID, status: 'active' }),
    );

    // The inline UPDATE accounts SET ... 'active' must NOT appear — the applier owns it
    // (mockSql in this file doesn't expose sqlCalls, so we verify the applier was called
    // and mockRetrieve was NOT called — if the inline block ran, it would call sql
    // directly, bypassing the applier mock entirely, and the expect above would fail)
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it('paid activation with changed=true triggers backfill resume', async () => {
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true,
      fromStatus: 'pending_payment',
      toStatus: 'active',
      changed: true,
      activated: true,
      primaryBusinessId: PRIMARY_BIZ,
    });

    await processCheckoutSessionCompleted({
      client_reference_id: ACCOUNT_ID,
      mode: 'subscription',
      payment_status: 'paid',
      amount_total: 7900,
      customer: CUSTOMER_ID,
      subscription: SUB_ID,
    } as any);

    expect(mockMaybeEnqueueBackfillResume).toHaveBeenCalledWith(PRIMARY_BIZ);
  });

  it('paid activation with changed=false skips backfill resume (idempotent re-delivery)', async () => {
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true,
      fromStatus: 'active',
      toStatus: 'active',
      changed: false,
      activated: false,
      primaryBusinessId: PRIMARY_BIZ,
    });
    mockMaybeEnqueueBackfillResume.mockClear();

    await processCheckoutSessionCompleted({
      client_reference_id: ACCOUNT_ID,
      mode: 'subscription',
      payment_status: 'paid',
      amount_total: 7900,
      customer: CUSTOMER_ID,
      subscription: SUB_ID,
    } as any);

    expect(mockMaybeEnqueueBackfillResume).not.toHaveBeenCalled();
  });
});

describe('checkout.session.completed — trial start', () => {
  it('paid + amount_total=0 + trialing sub → applier called (REAL card-up-front case)', async () => {
    // The exact shape that misfiled every prod trial as 'active': payment_status
    // 'paid', amount_total 0. Must still route to the trial applier.
    mockRetrieve.mockResolvedValue({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'trialing',
      trial_end: FUTURE_TRIAL_END,
    });

    await processCheckoutSessionCompleted(trialSession());

    expect(mockRetrieve).toHaveBeenCalledWith(SUB_ID);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({ mode: 'checkout', accountId: ACCOUNT_ID });
    expect(sub).toMatchObject({ status: 'trialing', trial_end: FUTURE_TRIAL_END });
  });

  it('no_payment_required + amount_total=0 + trialing sub → applier called (Stripe variant)', async () => {
    mockRetrieve.mockResolvedValue({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'trialing',
      trial_end: FUTURE_TRIAL_END,
    });

    await processCheckoutSessionCompleted(
      trialSession({ payment_status: 'no_payment_required' }),
    );

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(mockApplyStripeSubscriptionState.mock.calls[0]![1]).toEqual({
      mode: 'checkout',
      accountId: ACCOUNT_ID,
    });
  });

  it('normal paid sub (amount_total>0) → NO retrieve, routes through applier in checkout mode (B1.4)', async () => {
    // A real paying signup must NOT incur the trial Stripe retrieve (no extra
    // Stripe API call). After B1.4, the paid path routes through the applier
    // instead of the old inline UPDATE, so the applier IS called once.
    await processCheckoutSessionCompleted(
      trialSession({ payment_status: 'paid', amount_total: 7900 }),
    );

    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({ mode: 'checkout', accountId: ACCOUNT_ID });
    expect(sub).toMatchObject({ status: 'active' });
  });

  it('runs post-commit backfill resume when applier activated the account', async () => {
    mockRetrieve.mockResolvedValue({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'trialing',
      trial_end: FUTURE_TRIAL_END,
    });

    await processCheckoutSessionCompleted(trialSession());

    expect(mockMaybeEnqueueBackfillResume).toHaveBeenCalledWith(PRIMARY_BIZ);
  });

  it('retrieved sub is not trialing ($0 session, 100%-off coupon) → falls through to paid activation applier', async () => {
    // $0 session but the sub came back active (e.g. 100%-off coupon) — NOT a
    // trial. maybeStartTrial returns false so the handler falls through to the
    // paid activation path. After B1.4, that path routes through the applier
    // (checkout mode, status='active'), so the applier IS called once with
    // status='active' — it was previously the inline UPDATE.
    mockRetrieve.mockResolvedValue({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'active',
      trial_end: null,
    });

    await processCheckoutSessionCompleted(trialSession());

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, ref, sub] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({ mode: 'checkout', accountId: ACCOUNT_ID });
    expect(sub).toMatchObject({ status: 'active' });
  });

  it('trialing sub with a past trial_end is rejected (no applier call)', async () => {
    mockRetrieve.mockResolvedValue({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'trialing',
      trial_end: Math.floor(Date.now() / 1000) - 86400, // past
    });

    await processCheckoutSessionCompleted(trialSession());

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('mismatched customer (sub.customer != session.customer) is rejected', async () => {
    mockRetrieve.mockResolvedValue({
      id: SUB_ID,
      customer: 'cus_other',
      status: 'trialing',
      trial_end: FUTURE_TRIAL_END,
    });

    await processCheckoutSessionCompleted(trialSession());

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });
});
