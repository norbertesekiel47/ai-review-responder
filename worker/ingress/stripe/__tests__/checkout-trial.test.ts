import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * checkout.session.completed — TRIAL start path.
 *
 * When a Checkout Session was created with subscription_data.trial_period_days,
 * Stripe completes it with payment_status='no_payment_required' and the
 * retrieved subscription is status='trialing' with a future trial_end. The
 * handler retrieves the subscription (pinned client + timeout), verifies it, and
 * routes the trial-start through applyStripeSubscriptionState in checkout mode.
 * The paid (non-trial) path is unchanged.
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

function trialSession(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'cs_trial',
    mode: 'subscription',
    payment_status: 'no_payment_required',
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

describe('checkout.session.completed — trial start', () => {
  it('no_payment_required + trialing sub → applier called in checkout mode', async () => {
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

  it('skips applier when retrieved sub is not trialing (falls through to inline paid path)', async () => {
    // no_payment_required but the sub came back active (e.g. 100%-off coupon) —
    // NOT a trial. The trial applier must NOT fire; the existing inline paid
    // activation (status-guarded UPDATE accounts ... 'active') owns this case,
    // and it is the same inline path the paid branch uses (plan §4.11: paid
    // branch unchanged).
    mockRetrieve.mockResolvedValue({
      id: SUB_ID,
      customer: CUSTOMER_ID,
      status: 'active',
      trial_end: null,
    });

    await processCheckoutSessionCompleted(trialSession());

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
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
