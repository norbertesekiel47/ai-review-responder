import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * reconcileAccount — scoped corrective authority for stuck `trialing` rows.
 *
 * DB-trialing ↔ Stripe-trialing is the EXPECTED steady state (no drift). But a
 * DB `trialing` row whose Stripe status has MOVED (converted/cancelled/past_due)
 * — e.g. a missed/failed conversion webhook — is the ONE drift this poller
 * auto-corrects, by re-running the single applier. Everything else stays
 * alert-only. (PLAN.md §5.)
 */

const { mockSql, mockApplyStripeSubscriptionState, mockLoggerWarn } = vi.hoisted(() => {
  const mockSql: any = vi.fn(() => Promise.resolve(Object.assign([], { count: 0 })));
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));
  return {
    mockSql,
    mockApplyStripeSubscriptionState: vi.fn().mockResolvedValue({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    }),
    mockLoggerWarn: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../ingress/stripe/apply-subscription-state', () => ({
  applyStripeSubscriptionState: mockApplyStripeSubscriptionState,
}));
vi.mock('../../../../src/lib/shared/logger', () => ({
  createWorkerLogger: () => ({ warn: mockLoggerWarn, error: vi.fn(), log: vi.fn() }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

import { reconcileAccount } from '../billing-reconciliation/reconcile-account';
import type { AccountWithLocations } from '../billing-reconciliation/types';

function makeAccount(overrides: Partial<AccountWithLocations> = {}): AccountWithLocations {
  return {
    id: 'acct-1',
    subscription_tier: 'standard',
    subscription_status: 'trialing',
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_123',
    locations_included: 1,
    locations_overage_price_cents: 2500,
    base_price_cents: 7900,
    active_location_count: 0,
    past_due_at: null,
    flags: {},
    locations_paid: 0,
    ...overrides,
  };
}

function makeStripe(subStatus: string) {
  return {
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        id: 'sub_123', customer: 'cus_123', status: subStatus, trial_end: null,
        items: { data: [{ id: 'si_base', price: { id: 'price_base', unit_amount: 7900 }, quantity: 1 }] },
      }),
      list: vi.fn().mockResolvedValue({ data: [] }),
    },
    invoices: { createPreview: vi.fn().mockResolvedValue({ total: 7900, lines: { data: [] } }) },
  } as any;
}

beforeEach(() => {
  mockApplyStripeSubscriptionState.mockClear();
  mockSql.begin.mockClear();
  mockLoggerWarn.mockClear();
});

describe('reconcileAccount — trial correction', () => {
  it('DB trialing + Stripe active → corrects via applier, no status_mismatch drift', async () => {
    const stripe = makeStripe('active');
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const [, ref] = mockApplyStripeSubscriptionState.mock.calls[0]!;
    expect(ref).toEqual({
      mode: 'subscription',
      stripeCustomerId: 'cus_123',
      stripeSubscriptionId: 'sub_123',
    });
    expect(outcome.drifts.find((d) => d.driftType === 'status_mismatch')).toBeUndefined();
    expect(outcome.accountsChecked).toBe(1);
  });

  it('DB trialing + Stripe canceled → corrects via applier', async () => {
    const stripe = makeStripe('canceled');
    await reconcileAccount(mockSql, stripe, makeAccount());
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
  });

  it('DB trialing + Stripe still trialing → no correction, no drift (expected steady state)', async () => {
    const stripe = makeStripe('trialing');
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(outcome.drifts.find((d) => d.driftType === 'status_mismatch')).toBeUndefined();
  });

  it('DB active + Stripe active → no correction (not a trial row)', async () => {
    const stripe = makeStripe('active');
    await reconcileAccount(mockSql, stripe, makeAccount({ subscription_status: 'active' }));
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
  });

  it('logs the correction when the applier actually changed the row', async () => {
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'active',
      changed: true, activated: true, primaryBusinessId: null,
    });
    await reconcileAccount(mockSql, makeStripe('active'), makeAccount());
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Corrected stuck trialing row to match Stripe',
      expect.objectContaining({ account_id: 'acct-1' }),
    );
  });

  it('does NOT log a correction when the applier was a no-op (changed:false)', async () => {
    mockApplyStripeSubscriptionState.mockResolvedValueOnce({
      accountResolved: true, fromStatus: 'trialing', toStatus: 'trialing',
      changed: false, activated: false, primaryBusinessId: null,
    });
    await reconcileAccount(mockSql, makeStripe('active'), makeAccount());
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      'Corrected stuck trialing row to match Stripe',
      expect.anything(),
    );
  });

  it('DB active + Stripe trialing → surfaces status_mismatch drift (PLAN §15, not silently hidden)', async () => {
    const stripe = makeStripe('trialing');
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount({ subscription_status: 'active' }));
    // Not a DB-`trialing` row → the corrective applier must NOT run.
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    // The anomaly (DB active vs Stripe trialing) must be SURFACED, not suppressed
    // by the old `&& !stripeTrialing` clause.
    const drift = outcome.drifts.find((d) => d.driftType === 'status_mismatch');
    expect(drift).toBeDefined();
    expect(drift?.dbStatus).toBe('active');
    expect(drift?.stripeStatus).toBe('trialing');
  });
});
