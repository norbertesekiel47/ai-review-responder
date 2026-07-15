import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { mkTaggedResult } from '../../__tests__/helpers/mock-sql';

const {
  harness,
  mockRetrieveSubscription,
  mockApplyStripeSubscriptionState,
  mockWriteAccountAuditLog,
  mockCaptureMessage,
} = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../__tests__/helpers/mock-sql');
  return {
    harness: createMockSql(),
    mockRetrieveSubscription: vi.fn(),
    mockApplyStripeSubscriptionState: vi.fn(),
    mockWriteAccountAuditLog: vi.fn(),
    mockCaptureMessage: vi.fn(),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: harness.mockSql }));
vi.mock('../../../src/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    subscriptions: { retrieve: mockRetrieveSubscription },
  }),
}));
vi.mock('../../../src/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));
vi.mock('../stripe/apply-subscription-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stripe/apply-subscription-state')>();
  return {
    ...actual,
    applyStripeSubscriptionStateUnderEntitlementLock: mockApplyStripeSubscriptionState,
  };
});
vi.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  captureException: vi.fn(),
}));

import { processSubscriptionUpdated } from '../stripe/subscription-updated';
import { resetServerConfigForTests } from '../../../src/lib/config/server';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const CUSTOMER_ID = 'cus_ws8';
const SUBSCRIPTION_ID = 'sub_ws8';

const PRICE_ENV = {
  STRIPE_PRICE_COPILOT_LIST: 'price_copilot_list',
  STRIPE_PRICE_COPILOT_FOUNDING: 'price_copilot_founding',
  STRIPE_PRICE_AUTOPILOT_LIST: 'price_autopilot_list',
  STRIPE_PRICE_AUTOPILOT_FOUNDING: 'price_autopilot_founding',
  STRIPE_PRICE_COPILOT_OVERAGE: 'price_copilot_overage',
  STRIPE_PRICE_AUTOPILOT_OVERAGE: 'price_autopilot_overage',
} as const;

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    subscription_tier: 'copilot',
    subscription_status: 'active',
    price_variant: 'list',
    base_price_cents: 2900,
    locations_paid: 0,
    locations_overage_price_cents: 1500,
    locations_included: 1,
    stripe_customer_id: CUSTOMER_ID,
    stripe_subscription_id: SUBSCRIPTION_ID,
    active_offboarding_subscription_id: null,
    ...overrides,
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBSCRIPTION_ID,
    customer: CUSTOMER_ID,
    status: 'active',
    trial_end: null,
    metadata: {},
    items: {
      data: [
        {
          id: 'si_base',
          quantity: 1,
          metadata: {},
          price: { id: 'price_copilot_list', metadata: {}, unit_amount: 2900 },
        },
        {
          id: 'si_overage',
          quantity: 2,
          metadata: { billing_role: 'overage' },
          price: { id: 'price_copilot_overage', metadata: {}, unit_amount: 1500 },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function queueProjection(options: {
  account?: ReturnType<typeof account>;
  snapshotChanged?: boolean;
  reference?: Record<string, unknown>;
  includeSnapshot?: boolean;
} = {}) {
  harness.sqlReturnQueue.push(mkTaggedResult([{
    id: ACCOUNT_ID,
    stripe_subscription_id: SUBSCRIPTION_ID,
    active_offboarding_subscription_id: null,
    ...options.reference,
  }]));
  harness.sqlReturnQueue.push(mkTaggedResult([])); // entitlement lock
  harness.sqlReturnQueue.push(mkTaggedResult([])); // billing lock
  harness.sqlReturnQueue.push(mkTaggedResult([options.account ?? account()]));
  if (options.includeSnapshot !== false) {
    harness.sqlReturnQueue.push(
      mkTaggedResult(options.snapshotChanged === false ? [] : [{ id: ACCOUNT_ID }]),
    );
  }
  // Successful billing projection converges the deprecated tier mirror only
  // after commit: business -> entitlement -> canonical tier -> update.
  if (options.includeSnapshot !== false) {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{ id: 'business-1' }]),
      mkTaggedResult([]),
      mkTaggedResult([{
        subscription_tier: options.account?.subscription_tier ?? 'copilot',
      }]),
      mkTaggedResult([]),
    );
  }
  // Status ownership is independent: every resolved outcome reprojects status
  // and the activation anchor in the same business -> entitlement order.
  harness.sqlReturnQueue.push(
    mkTaggedResult([{ id: 'business-1' }]),
    mkTaggedResult([]),
    mkTaggedResult([{
      subscription_status: options.account?.subscription_status ?? 'active',
      subscription_activated_at: new Date('2026-07-15T00:00:00Z'),
    }]),
    mkTaggedResult([]),
  );
}

function snapshotUpdates() {
  return harness.sqlCalls.filter(
    (call) => /UPDATE\s+accounts/i.test(call.text) && /base_price_cents/i.test(call.text),
  );
}

function businessProjectionUpdates() {
  return harness.sqlCalls.filter(
    (call) => /UPDATE\s+businesses/i.test(call.text) && /subscription_tier/i.test(call.text),
  );
}

function businessStatusProjectionUpdates() {
  return harness.sqlCalls.filter(
    (call) => /UPDATE\s+businesses/i.test(call.text) && /subscription_status/i.test(call.text),
  );
}

function installPostCommitOrder(order: string[]): void {
  harness.mockSql.begin.mockImplementationOnce(async (
    optionsOrCallback: string | ((tx: unknown) => Promise<unknown>),
    callback?: (tx: unknown) => Promise<unknown>,
  ) => {
    const run = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callback;
    if (!run) throw new Error('missing transaction callback');
    const result = await run(harness.mockSql);
    order.push('commit');
    return result;
  });
}

function expectExactSqlCalls(expected: number): void {
  expect(harness.sqlCalls).toHaveLength(expected);
  expect(harness.sqlReturnQueue).toHaveLength(0);
}

beforeEach(() => {
  harness.sqlReturnQueue.length = 0;
  harness.sqlCalls.length = 0;
  harness.mockSql.begin.mockClear();
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(PRICE_ENV)) process.env[key] = value;
  process.env.AUTOPILOT_PURCHASABLE = 'true';
  process.env.AUTO_APPROVAL_ENABLED = 'true';
  resetServerConfigForTests();
  mockApplyStripeSubscriptionState.mockResolvedValue({
    accountResolved: true,
    fromStatus: 'active',
    toStatus: 'active',
    changed: false,
    activated: false,
    primaryBusinessId: null,
  });
  mockWriteAccountAuditLog.mockResolvedValue(undefined);
  mockRetrieveSubscription.mockResolvedValue(subscription());
});

describe('customer.subscription.updated — WS8 provider-current projection', () => {
  it('same-tier list replay preserves stored cents/quota and syncs trusted quantity', async () => {
    queueProjection({
      account: account({
        base_price_cents: 2800,
        locations_overage_price_cents: 1400,
        locations_included: 2,
      }),
    });

    const outcome = await processSubscriptionUpdated(subscription({
      items: { data: [] }, // stale event snapshot must be ignored
    }));

    expect(outcome).toMatchObject({
      kind: 'updated',
      tier: 'copilot',
      variant: 'list',
      snapshotChanged: true,
    });
    expect(mockRetrieveSubscription).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const update = snapshotUpdates()[0]!;
    expect(update.values).toEqual(expect.arrayContaining([
      'copilot', 2800, 1400, 2, 2, ACCOUNT_ID,
    ]));
    expect(update.values).not.toContain(2900);
    expect(update.values).not.toContain(1500);
    expectExactSqlCalls(13);
  });

  it('changed-false replay repairs the deferred status and activation mirror', async () => {
    queueProjection({ snapshotChanged: false });

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({
      kind: 'updated',
      snapshotChanged: false,
      transition: { accountResolved: true, changed: false },
    });
    expect(businessStatusProjectionUpdates()).toHaveLength(1);
    expect(businessStatusProjectionUpdates()[0]!.text).toMatch(
      /subscription_activated_at\s*=\s*COALESCE/i,
    );
    expectExactSqlCalls(13);
  });

  it('same-tier founding subscription preserves the founding stored snapshot', async () => {
    queueProjection({
      account: account({
        price_variant: 'founding',
        base_price_cents: 1900,
      }),
    });
    mockRetrieveSubscription.mockResolvedValue(subscription({
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_copilot_founding', metadata: {}, unit_amount: 1900 },
          },
        ],
      },
    }));

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({ kind: 'updated', variant: 'founding' });
    expect(snapshotUpdates()[0]!.values).toEqual(
      expect.arrayContaining(['copilot', 1900, 1500, 1, 0]),
    );
    expectExactSqlCalls(13);
  });

  it('founding Copilot to Autopilot writes the complete canonical founding snapshot', async () => {
    queueProjection({
      account: account({
        price_variant: 'founding',
        base_price_cents: 1900,
      }),
    });
    mockRetrieveSubscription.mockResolvedValue(subscription({
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_autopilot_founding', metadata: {}, unit_amount: 4900 },
          },
          {
            id: 'si_overage', quantity: 3, metadata: { billing_role: 'overage' },
            price: { id: 'price_autopilot_overage', metadata: {}, unit_amount: 2000 },
          },
        ],
      },
    }));

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({
      kind: 'updated', tier: 'autopilot', variant: 'founding', snapshotChanged: true,
    });
    expect(snapshotUpdates()[0]!.values).toEqual(
      expect.arrayContaining(['autopilot', 4900, 2000, 1, 3]),
    );
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expectExactSqlCalls(13);
  });

  it('unknown base Price commits status-only and emits a scrubbed post-commit alert', async () => {
    queueProjection({ includeSnapshot: false });
    mockRetrieveSubscription.mockResolvedValue(subscription({
      metadata: { secret: 'never-log-me' },
      items: {
        data: [{
          id: 'si_unknown', quantity: 1, metadata: { access_token: 'never' },
          price: { id: 'price_unknown', metadata: { secret: 'never' }, unit_amount: 9999 },
        }],
      },
    }));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({
      kind: 'status_only', reason: 'unmapped_base_price',
    });
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(snapshotUpdates()).toEqual([]);
    expect(businessProjectionUpdates()).toEqual([]);
    expect(businessStatusProjectionUpdates()).toHaveLength(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const sentryPayload = JSON.stringify(mockCaptureMessage.mock.calls[0]);
    expect(sentryPayload).toContain('price_unknown');
    expect(sentryPayload).not.toContain('never-log-me');
    expect(sentryPayload).not.toContain('access_token');
    expect(sentryPayload).not.toContain(CUSTOMER_ID);
    expect(consoleSpy.mock.calls.flat().join(' ')).not.toContain('never-log-me');
    consoleSpy.mockRestore();
    expectExactSqlCalls(8);
  });

  it('mapped Price variant mismatch returns typed status-only outcome and never writes a snapshot', async () => {
    queueProjection({
      account: account({ price_variant: 'founding', base_price_cents: 1900 }),
      includeSnapshot: false,
    });
    mockRetrieveSubscription.mockResolvedValue(subscription());
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({
      kind: 'variant_mismatch',
      priceId: 'price_copilot_list',
      mappedTier: 'copilot',
      mappedVariant: 'list',
      storedVariant: 'founding',
    });
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(snapshotUpdates()).toEqual([]);
    // Variant mismatch preserves the immutable stored variant and performs no
    // tier-mirror repair even if that deprecated mirror is stale. Status
    // projection remains independently owned by the status applier.
    expect(businessProjectionUpdates()).toEqual([]);
    expect(businessStatusProjectionUpdates()).toHaveLength(1);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'stripe_subscription_projection_variant_mismatch',
      expect.objectContaining({
        extra: expect.objectContaining({
          price_id: 'price_copilot_list',
          mapped_variant: 'list',
          stored_variant: 'founding',
        }),
      }),
    );
    consoleSpy.mockRestore();
    expectExactSqlCalls(8);
  });

  it('reports mismatch only after the status-only transaction has committed', async () => {
    const order: string[] = [];
    queueProjection({
      account: account({ price_variant: 'founding', base_price_cents: 1900 }),
      includeSnapshot: false,
    });
    installPostCommitOrder(order);
    mockApplyStripeSubscriptionState.mockImplementationOnce(async () => {
      order.push('status');
      return {
        accountResolved: true,
        fromStatus: 'trialing',
        toStatus: 'active',
        changed: true,
        activated: true,
        primaryBusinessId: null,
      };
    });
    mockCaptureMessage.mockImplementationOnce(() => {
      order.push('alert');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processSubscriptionUpdated(subscription());

    expect(order).toEqual(['status', 'commit', 'alert']);
    consoleSpy.mockRestore();
    expectExactSqlCalls(8);
  });

  it('trialing account + provider-current active mapped Price enters the single applier then projects billing', async () => {
    queueProjection({
      account: account({ subscription_status: 'trialing' }),
    });
    mockRetrieveSubscription.mockResolvedValue(subscription({ status: 'active' }));

    const outcome = await processSubscriptionUpdated(subscription({ status: 'trialing' }));

    expect(outcome).toMatchObject({ kind: 'updated', tier: 'copilot' });
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      {
        mode: 'subscription',
        stripeCustomerId: CUSTOMER_ID,
        stripeSubscriptionId: SUBSCRIPTION_ID,
      },
      expect.objectContaining({ status: 'active' }),
    );
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(snapshotUpdates()).toHaveLength(1);
    expectExactSqlCalls(13);
  });

  it('trialing account + provider-current active unmapped Price applies status but remains status-only', async () => {
    const order: string[] = [];
    queueProjection({
      account: account({ subscription_status: 'trialing' }),
      includeSnapshot: false,
    });
    mockRetrieveSubscription.mockResolvedValue(subscription({
      status: 'active',
      metadata: { secret: 'provider-secret' },
      items: {
        data: [{
          id: 'si_unmapped', quantity: 1, metadata: { access_token: 'hidden' },
          price: { id: 'price_rotated_unmapped', metadata: {}, unit_amount: 2900 },
        }],
      },
    }));
    installPostCommitOrder(order);
    mockApplyStripeSubscriptionState.mockImplementationOnce(async () => {
      order.push('status');
      return {
        accountResolved: true,
        fromStatus: 'trialing',
        toStatus: 'active',
        changed: true,
        activated: true,
        primaryBusinessId: null,
      };
    });
    mockCaptureMessage.mockImplementationOnce(() => {
      order.push('alert');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await processSubscriptionUpdated(subscription({ status: 'trialing' }));

    expect(outcome).toMatchObject({ kind: 'status_only', reason: 'unmapped_base_price' });
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: 'subscription',
        stripeSubscriptionId: SUBSCRIPTION_ID,
      }),
      expect.objectContaining({ status: 'active' }),
    );
    expect(snapshotUpdates()).toEqual([]);
    expect(businessProjectionUpdates()).toEqual([]);
    expect(businessStatusProjectionUpdates()).toHaveLength(1);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(order).toEqual(['status', 'commit', 'alert']);
    const alertPayload = JSON.stringify(mockCaptureMessage.mock.calls[0]);
    expect(alertPayload).toContain('price_rotated_unmapped');
    expect(alertPayload).not.toContain('provider-secret');
    expect(alertPayload).not.toContain('access_token');
    expect(alertPayload).not.toContain(CUSTOMER_ID);
    consoleSpy.mockRestore();
    expectExactSqlCalls(8);
  });

  it.each([
    {
      reason: 'untrusted_overage_item' as const,
      items: [
        {
          id: 'si_base', quantity: 1, metadata: {},
          price: { id: 'price_copilot_list', metadata: {}, unit_amount: 2900 },
        },
        {
          id: 'si_untrusted', quantity: 3, metadata: {},
          price: {
            id: 'price_support_addon',
            nickname: 'Extra Location Add-on',
            metadata: { secret: 'branch-secret' },
            unit_amount: 777,
          },
        },
      ],
    },
    {
      reason: 'cross_tier_overage_price' as const,
      items: [
        {
          id: 'si_base', quantity: 1, metadata: {},
          price: { id: 'price_copilot_list', metadata: {}, unit_amount: 2900 },
        },
        {
          id: 'si_cross_tier', quantity: 2, metadata: { billing_role: 'overage' },
          price: { id: 'price_autopilot_overage', metadata: {}, unit_amount: 2000 },
        },
      ],
    },
    {
      reason: 'invalid_overage_quantity' as const,
      items: [
        {
          id: 'si_base', quantity: 1, metadata: {},
          price: { id: 'price_copilot_list', metadata: {}, unit_amount: 2900 },
        },
        {
          id: 'si_invalid_quantity', quantity: 1.5, metadata: { billing_role: 'overage' },
          price: { id: 'price_copilot_overage', metadata: {}, unit_amount: 1500 },
        },
      ],
    },
  ])(
    '$reason applies status, performs zero billing projection writes, and alerts after commit',
    async ({ reason, items }) => {
      const order: string[] = [];
      queueProjection({ includeSnapshot: false });
      mockRetrieveSubscription.mockResolvedValue(subscription({
        metadata: { access_token: 'provider-secret' },
        items: { data: items },
      }));
      installPostCommitOrder(order);
      mockApplyStripeSubscriptionState.mockImplementationOnce(async () => {
        order.push('status');
        return {
          accountResolved: true,
          fromStatus: 'active',
          toStatus: 'active',
          changed: false,
          activated: false,
          primaryBusinessId: null,
        };
      });
      mockCaptureMessage.mockImplementationOnce(() => {
        order.push('alert');
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const outcome = await processSubscriptionUpdated(subscription());

      expect(outcome).toMatchObject({ kind: 'status_only', reason });
      expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
      expect(snapshotUpdates()).toEqual([]);
      expect(businessProjectionUpdates()).toEqual([]);
      expect(businessStatusProjectionUpdates()).toHaveLength(1);
      expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
      expect(order).toEqual(['status', 'commit', 'alert']);
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        `stripe_subscription_projection_${reason}`,
        expect.objectContaining({
          extra: expect.objectContaining({ reason }),
        }),
      );
      const alertPayload = JSON.stringify(mockCaptureMessage.mock.calls[0]);
      expect(alertPayload).not.toContain('provider-secret');
      expect(alertPayload).not.toContain('branch-secret');
      expect(alertPayload).not.toContain('access_token');
      expect(alertPayload).not.toContain(CUSTOMER_ID);
      consoleSpy.mockRestore();
      expectExactSqlCalls(8);
    },
  );

  it('replay is change-only: status applies twice but the billing audit is written once', async () => {
    queueProjection({ snapshotChanged: true });
    queueProjection({ snapshotChanged: false });

    const first = await processSubscriptionUpdated(subscription());
    const second = await processSubscriptionUpdated(subscription());

    expect(first).toMatchObject({ kind: 'updated', snapshotChanged: true });
    expect(second).toMatchObject({ kind: 'updated', snapshotChanged: false });
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(2);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledTimes(1);
    expectExactSqlCalls(26);
  });

  it('reversed base-change delivery converges to the retrieved provider-current tier', async () => {
    queueProjection();
    mockRetrieveSubscription.mockResolvedValue(subscription({
      items: {
        data: [{
          id: 'si_base', quantity: 1, metadata: {},
          price: { id: 'price_autopilot_list', metadata: {}, unit_amount: 6900 },
        }],
      },
    }));

    const outcome = await processSubscriptionUpdated(subscription({
      items: {
        data: [{
          id: 'stale_base', quantity: 1,
          price: { id: 'price_copilot_list', unit_amount: 2900 },
        }],
      },
    }));

    expect(outcome).toMatchObject({ kind: 'updated', tier: 'autopilot' });
    expect(snapshotUpdates()[0]!.values).toEqual(
      expect.arrayContaining(['autopilot', 6900, 2000, 1, 0]),
    );
    expectExactSqlCalls(13);
  });

  it('reversed overage delivery converges to provider-current quantity', async () => {
    queueProjection();
    mockRetrieveSubscription.mockResolvedValue(subscription()); // current qty=2

    await processSubscriptionUpdated(subscription({
      items: {
        data: [{
          id: 'stale_overage', quantity: 99,
          price: { id: 'price_copilot_overage', unit_amount: 1500 },
        }],
      },
    }));

    const update = snapshotUpdates()[0]!;
    expect(update.values).toContain(2);
    expect(update.values).not.toContain(99);
    expectExactSqlCalls(13);
  });

  it('matching Autopilot full-access state while the gate is closed preserves state and alerts', async () => {
    process.env.AUTOPILOT_PURCHASABLE = 'false';
    resetServerConfigForTests();
    queueProjection({
      account: account({
        subscription_tier: 'autopilot',
        base_price_cents: 6900,
        locations_overage_price_cents: 2000,
      }),
    });
    mockRetrieveSubscription.mockResolvedValue(subscription({
      items: {
        data: [{
          id: 'si_base', quantity: 1, metadata: {},
          price: { id: 'price_autopilot_list', metadata: {}, unit_amount: 6900 },
        }],
      },
    }));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({ kind: 'updated', tier: 'autopilot' });
    expect(outcome.alerts).toEqual([
      expect.objectContaining({ reason: 'autopilot_activated_while_unavailable' }),
    ]);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'stripe_subscription_projection_autopilot_activated_while_unavailable',
      expect.anything(),
    );
    consoleSpy.mockRestore();
    expectExactSqlCalls(13);
  });

  it('provider retrieval failure retries before account row lock or any status write', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{
      id: ACCOUNT_ID,
      stripe_subscription_id: SUBSCRIPTION_ID,
      active_offboarding_subscription_id: null,
    }]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    mockRetrieveSubscription.mockRejectedValueOnce(new Error('Stripe unavailable'));

    await expect(processSubscriptionUpdated(subscription())).rejects.toThrow('Stripe unavailable');

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(snapshotUpdates()).toEqual([]);
    expect(harness.sqlCalls.some((call) => /FOR\s+UPDATE/i.test(call.text))).toBe(false);
    expectExactSqlCalls(3);
  });

  it('account disappearance before the applier performs no post-commit projection', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{
        id: ACCOUNT_ID,
        stripe_subscription_id: SUBSCRIPTION_ID,
        active_offboarding_subscription_id: null,
      }]),
      mkTaggedResult([]),
      mkTaggedResult([]),
      mkTaggedResult([]),
    );

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({ kind: 'ignored', reason: 'account_disappeared' });
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(businessProjectionUpdates()).toEqual([]);
    expect(businessStatusProjectionUpdates()).toEqual([]);
    expectExactSqlCalls(4);
  });

  it('provider customer mismatch before the applier leaves both mirrors untouched', async () => {
    harness.sqlReturnQueue.push(
      mkTaggedResult([{
        id: ACCOUNT_ID,
        stripe_subscription_id: SUBSCRIPTION_ID,
        active_offboarding_subscription_id: null,
      }]),
      mkTaggedResult([]),
      mkTaggedResult([]),
      mkTaggedResult([account()]),
    );
    mockRetrieveSubscription.mockResolvedValueOnce(subscription({ customer: 'cus_other' }));

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({ kind: 'ignored', reason: 'provider_customer_mismatch' });
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(businessProjectionUpdates()).toEqual([]);
    expect(businessStatusProjectionUpdates()).toEqual([]);
    expectExactSqlCalls(4);
  });

  it('stale subscription resolves without a row lock and never retrieves Stripe', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{
      id: ACCOUNT_ID,
      stripe_subscription_id: 'sub_current',
      active_offboarding_subscription_id: null,
    }]));

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({ kind: 'ignored', reason: 'stale_subscription' });
    expect(mockRetrieveSubscription).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(snapshotUpdates()).toEqual([]);
    expectExactSqlCalls(1);
  });

  it('multi-account customer resolution prioritizes the exact current subscription', async () => {
    queueProjection();

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({ kind: 'updated', accountId: ACCOUNT_ID });
    const resolutionSql = harness.sqlCalls[0]!.text;
    const currentPriority = resolutionSql.indexOf('0 AS resolution_priority');
    const offboardingPriority = resolutionSql.indexOf('1 AS resolution_priority');
    const stalePriority = resolutionSql.indexOf('2 AS resolution_priority');
    expect(currentPriority).toBeGreaterThanOrEqual(0);
    expect(offboardingPriority).toBeGreaterThan(currentPriority);
    expect(stalePriority).toBeGreaterThan(offboardingPriority);
    expect(resolutionSql).toMatch(/ORDER BY\s+resolution_priority ASC, id ASC/i);
    expect(resolutionSql).not.toMatch(/FOR\s+UPDATE/i);
    expectExactSqlCalls(13);
  });

  it('multi-account customer resolution prioritizes an exact active-offboarding subscription before stale fallback', async () => {
    harness.sqlReturnQueue.push(mkTaggedResult([{
      id: ACCOUNT_ID,
      stripe_subscription_id: 'sub_replacement',
      active_offboarding_subscription_id: SUBSCRIPTION_ID,
    }]));

    const outcome = await processSubscriptionUpdated(subscription());

    expect(outcome).toMatchObject({
      kind: 'ignored',
      reason: 'active_offboarding_subscription',
      accountId: ACCOUNT_ID,
    });
    expect(mockRetrieveSubscription).not.toHaveBeenCalled();
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(snapshotUpdates()).toEqual([]);
    expect(businessProjectionUpdates()).toEqual([]);
    expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
    expect(harness.sqlCalls[0]!.text).toContain('account_offboardings');
    expect(harness.sqlCalls[0]!.text).not.toMatch(/FOR\s+UPDATE/i);
    expectExactSqlCalls(1);
  });

  it('takes entitlement then billing before the account row and drains the exact SQL queue', async () => {
    queueProjection();

    await processSubscriptionUpdated(subscription());

    const entitlementIndex = harness.sqlCalls.findIndex((call) =>
      call.values.includes(`${ACCOUNT_ID}:tier_entitlement`),
    );
    const billingIndex = harness.sqlCalls.findIndex((call) =>
      call.values.includes(`${ACCOUNT_ID}:overage_sync`),
    );
    const accountRowIndex = harness.sqlCalls.findIndex((call) =>
      /FROM\s+accounts/i.test(call.text) && /FOR\s+UPDATE/i.test(call.text),
    );
    expect(entitlementIndex).toBeGreaterThanOrEqual(0);
    expect(billingIndex).toBeGreaterThan(entitlementIndex);
    expect(accountRowIndex).toBeGreaterThan(billingIndex);
    expectExactSqlCalls(13);
  });
});
