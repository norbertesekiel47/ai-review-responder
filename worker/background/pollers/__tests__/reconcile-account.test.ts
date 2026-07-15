// worker/background/pollers/__tests__/reconcile-account.test.ts
//
// Unit tests for the per-account reconcile step. The Stripe client is injected,
// so no module mock is needed for Stripe — a hand-rolled fake covers each
// outbound call. The sql module IS mocked here to support the lineage query
// (RECONCILE-F6) and the trial-correction sql.begin path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSql, sqlReturnQueue } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn(() => {
    const q = sqlReturnQueue.shift();
    return Promise.resolve(q ?? Object.assign([], { count: 0 }));
  });
  mockSql.begin = vi.fn(async (cb: any) => cb(mockSql));
  return { mockSql, sqlReturnQueue };
});
vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));

import { reconcileAccount } from '../billing-reconciliation/reconcile-account';
import type { AccountWithLocations } from '../billing-reconciliation/types';

function makeAccount(overrides: Partial<AccountWithLocations> = {}): AccountWithLocations {
  return {
    id: 'acct-1',
    subscription_tier: 'copilot',
    subscription_status: 'active',
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_123',
    locations_included: 1,
    locations_overage_price_cents: 2500,
    base_price_cents: 7900,
    active_location_count: 3,
    past_due_at: null,
    flags: {},
    locations_paid: 2,
    ...overrides,
  };
}

function makeSubscription(overageQuantity: number, overageUnitAmount = 2500) {
  return {
    id: 'sub_test',
    customer: 'cus_123',
    status: 'active',
    items: { data: [
      { id: 'si_base', price: { id: 'price_base', unit_amount: 7900 }, quantity: 1 },
      { id: 'si_over', price: { id: 'price_overage_std', unit_amount: overageUnitAmount }, quantity: overageQuantity },
    ] },
  };
}

function makePreview(overageUnits = 2, overageUnitCents = 2500, baseCents = 7900) {
  const lines: any[] = [
    { id: 'il_base', amount: baseCents, subtotal: baseCents, quantity: 1,
      price: { id: 'price_base', unit_amount: baseCents },
      parent: { subscription_item_details: { proration: false, subscription_item: 'si_base' } } },
  ];
  if (overageUnits > 0) {
    lines.push({ id: 'il_over', amount: overageUnits * overageUnitCents, subtotal: overageUnits * overageUnitCents,
      quantity: overageUnits, price: { id: 'price_overage_std', unit_amount: overageUnitCents },
      parent: { subscription_item_details: { proration: false, subscription_item: 'si_over' } } });
  }
  return { total: baseCents + overageUnits * overageUnitCents, lines: { data: lines } };
}

function makeStripe(opts: {
  retrieve?: unknown; list?: unknown; createPreview?: unknown;
  retrieveError?: unknown; createPreviewError?: unknown; listError?: unknown;
}) {
  return {
    subscriptions: {
      retrieve: opts.retrieveError
        ? vi.fn().mockRejectedValue(opts.retrieveError)
        : vi.fn().mockResolvedValue(opts.retrieve),
      list: opts.listError
        ? vi.fn().mockRejectedValue(opts.listError)
        : vi.fn().mockResolvedValue(opts.list ?? { data: [] }),
    },
    invoices: {
      createPreview: opts.createPreviewError
        ? vi.fn().mockRejectedValue(opts.createPreviewError)
        : vi.fn().mockResolvedValue(opts.createPreview ?? makePreview()),
    },
  } as any;
}



describe('reconcileAccount', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns checked:1 with no drift for a matching account', async () => {
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());
    expect(outcome).toEqual({ accountsChecked: 1, drifts: [], errors: 0 });
  });

  it('returns errors:1 checked:0 for an unknown tier', async () => {
    const stripe = makeStripe({});
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount({ subscription_tier: 'nope' }));
    expect(outcome.accountsChecked).toBe(0);
    expect(outcome.errors).toBe(1);
    expect(outcome.drifts).toEqual([]);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('reports missing_subscription when stripe_subscription_id is null', async () => {
    const stripe = makeStripe({});
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount({ stripe_subscription_id: null }));
    expect(outcome.accountsChecked).toBe(1);
    expect(outcome.errors).toBe(0);
    expect(outcome.drifts).toHaveLength(1);
    expect(outcome.drifts[0]!.driftType).toBe('missing_subscription');
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('reports missing_subscription (handled) when Stripe 404s the subscription', async () => {
    const err = Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
    const stripe = makeStripe({ retrieveError: err });
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());
    expect(outcome).toMatchObject({ accountsChecked: 1, errors: 0 });
    expect(outcome.drifts).toHaveLength(1);
    expect(outcome.drifts[0]!.driftType).toBe('missing_subscription');
  });

  it('re-throws a non-missing Stripe retrieve error', async () => {
    const stripe = makeStripe({ retrieveError: new Error('Stripe API timeout') });
    await expect(reconcileAccount(mockSql, stripe, makeAccount())).rejects.toThrow('Stripe API timeout');
  });

  it('counts a duplicate-list failure as a handled error and still checks the account', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(2), createPreview: makePreview(2),
      listError: new Error('list failed'),
    });
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());
    expect(outcome.accountsChecked).toBe(1);
    expect(outcome.errors).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Error listing Stripe subscriptions'));
  });

  it('still reports quantity drift when the invoice preview fails', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(5),
      createPreviewError: new Error('preview timeout'),
    });
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount({ active_location_count: 3, locations_included: 1 }));
    expect(outcome.accountsChecked).toBe(1);
    expect(outcome.errors).toBe(1);
    expect(outcome.drifts.some((d) => d.driftType === 'quantity_mismatch')).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invoice-preview reconciliation UNAVAILABLE'));
  });

  it('passes a bounded per-request timeout to subscriptions.retrieve', async () => {
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    await reconcileAccount(mockSql, stripe, makeAccount());
    // The Stripe SDK retrieve overload is (id, params?, options?), so the
    // RequestOptions carrying `timeout` is the THIRD positional arg.
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith(
      'sub_123',
      {},
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('passes a bounded per-request timeout to subscriptions.list', async () => {
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    await reconcileAccount(mockSql, stripe, makeAccount());
    // SDK overload is list(params?, options?) — timeout rides the SECOND arg.
    expect(stripe.subscriptions.list).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_123' }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('passes a bounded per-request timeout to invoices.createPreview', async () => {
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    await reconcileAccount(mockSql, stripe, makeAccount());
    // SDK overload is createPreview(params?, options?) — timeout rides the SECOND arg.
    expect(stripe.invoices.createPreview).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_123', subscription: 'sub_123' }),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('emits a locations_paid_mirror drift when the DB mirror disagrees with Stripe overage qty', async () => {
    // Stripe overage quantity = 2, but the DB mirror says 5 → drift.
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount({ locations_paid: 5, active_location_count: 3 }));
    expect(outcome.drifts.some((d) => d.driftType === 'locations_paid_mirror')).toBe(true);
  });

  it('does NOT emit a locations_paid_mirror drift when the mirror matches Stripe overage qty', async () => {
    const stripe = makeStripe({ retrieve: makeSubscription(2), createPreview: makePreview(2) });
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount({ locations_paid: 2, active_location_count: 3 }));
    expect(outcome.drifts.some((d) => d.driftType === 'locations_paid_mirror')).toBe(false);
  });

  it('reports a duplicate_subscription drift', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(2), createPreview: makePreview(2),
      list: { data: [ { id: 'sub_123', status: 'active' }, { id: 'sub_dup', status: 'active' } ] },
    });
    sqlReturnQueue.push([]); // lineage query: no subs belong to another account
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());
    expect(outcome.drifts.some((d) => d.driftType === 'duplicate_subscription')).toBe(true);
  });

  // RECONCILE-F6: lineage-scoped duplicate detection
  it('does NOT flag duplicate_subscription when the extra active sub belongs to another account', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(2),
      list: { data: [
        { id: 'sub_123', status: 'active' },   // this account's
        { id: 'sub_other', status: 'active' },  // a sibling account's
      ] },
      createPreview: makePreview(2),
    });
    sqlReturnQueue.push([{ stripe_subscription_id: 'sub_other' }]); // lineage query: sub_other belongs to a DIFFERENT account
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());
    expect(outcome.drifts.some((d) => d.driftType === 'duplicate_subscription')).toBe(false);
  });

  // #267 — DRIFT-DETECTION SAFETY LOCK. The poller's base-item resolution is
  // intentionally tolerant of a legacy/rotated/grandfathered base price (one that
  // is NOT in the env price-tier-map): such a price still resolves via the
  // resolver's INFERRED fallback so its unit_amount stays comparable to the
  // account's STORED base_price_cents and `price_mismatch` still fires. A naive
  // "positive-only" base resolution would drop the base item and silently swallow
  // this drift — exactly what this poller exists to catch. This test must stay
  // green across the base-resolution refactor.
  it('still flags price_mismatch for a legacy/rotated/grandfathered base price (inferred fallback)', async () => {
    const legacySubscription = {
      id: 'sub_legacy',
      customer: 'cus_123',
      status: 'active',
      items: { data: [
        // Base price is NOT the env-mapped price and its unit_amount has drifted
        // from the account's stored base_price_cents (7900).
        { id: 'si_base', price: { id: 'price_legacy_base', unit_amount: 6900 }, quantity: 1 },
        { id: 'si_over', price: { id: 'price_overage_std', unit_amount: 2500 }, quantity: 2 },
      ] },
    };
    const stripe = makeStripe({ retrieve: legacySubscription, createPreview: makePreview(2) });
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());
    const priceDrift = outcome.drifts.find((d) => d.driftType === 'price_mismatch');
    expect(priceDrift).toBeDefined();
    expect(priceDrift?.expectedCents).toBe(7900);
    expect(priceDrift?.actualCents).toBe(6900);
  });

  it('flags duplicate_subscription when 2+ active subs belong to THIS account lineage', async () => {
    const stripe = makeStripe({
      retrieve: makeSubscription(2),
      list: { data: [
        { id: 'sub_123', status: 'active' },
        { id: 'sub_dupe', status: 'active' },
      ] },
      createPreview: makePreview(2),
    });
    sqlReturnQueue.push([]); // lineage query: neither maps to another account
    const outcome = await reconcileAccount(mockSql, stripe, makeAccount());
    expect(outcome.drifts.some((d) => d.driftType === 'duplicate_subscription')).toBe(true);
  });
});
