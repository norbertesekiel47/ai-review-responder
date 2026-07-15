import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSql,
  mockSqlQueue,
  mockAccountState,
  mockApplyStripeSubscriptionState,
  mockResumePrimaryBusinessBackfill,
  mockRetrieve,
  mockReportCaughtError,
  mockAutopilotPurchasable,
} = vi.hoisted(() => {
  const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
  const mockSqlQueue: Array<unknown | (() => unknown)> = [];
  const mockAccountState = {
    row: {
      id: ACCOUNT_ID,
      subscription_tier: 'copilot',
      subscription_status: 'active',
      price_variant: 'list',
      base_price_cents: 2900,
      locations_paid: 0,
      locations_overage_price_cents: 1500,
      locations_included: 1,
      stripe_subscription_id: null as string | null,
      stripe_customer_id: null as string | null,
    },
  };
  const mockSql: any = vi.fn((strings: TemplateStringsArray) => {
    const text = Array.from(strings).join('?').replace(/\s+/g, ' ').trim();
    if (mockSqlQueue.length === 0) {
      throw new Error(`Unexpected SQL after queue drained: ${text}`);
    }
    const next = mockSqlQueue.shift();
    return Promise.resolve(typeof next === 'function' ? next() : next);
  });
  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => callback(mockSql));
  mockSql.json = vi.fn((value: unknown) => value);
  return {
    mockSql,
    mockSqlQueue,
    mockAccountState,
    mockApplyStripeSubscriptionState: vi.fn(),
    mockResumePrimaryBusinessBackfill: vi.fn().mockResolvedValue(undefined),
    mockRetrieve: vi.fn(),
    mockReportCaughtError: vi.fn(),
    mockAutopilotPurchasable: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../apply-subscription-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apply-subscription-state')>()),
  applyStripeSubscriptionStateUnderEntitlementLock: mockApplyStripeSubscriptionState,
}));
vi.mock('../shared', async () => {
  const actual = await vi.importActual<typeof import('../shared')>('../shared');
  return {
    ...actual,
    resumePrimaryBusinessBackfill: mockResumePrimaryBusinessBackfill,
    getStripe: () => ({ subscriptions: { retrieve: mockRetrieve } }),
  };
});
vi.mock('../../../../src/lib/shared/job-outbox-helpers', () => ({
  enqueueStripeOverageRecompute: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../src/lib/shared/report-caught-error', () => ({
  reportCaughtError: mockReportCaughtError,
}));
vi.mock('../../../../src/lib/payments/tier-purchasability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/payments/tier-purchasability')>()),
  autopilotPurchasable: mockAutopilotPurchasable,
}));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid-v7') }));

import { processCheckoutSessionCompleted } from '../checkout-completed';
import { SubscriptionTier, TIER_CONFIG } from '../../../../src/lib/accounts/tier-config';

const ACCOUNT_ID = '019dc366-29ce-7000-a000-000000000001';
const PRIMARY_BIZ = '019dc366-29ce-7000-a000-0000000000bb';
const CUSTOMER_ID = 'cus_test_123';
const SUB_ID = 'sub_test_456';
const SUB_A = 'sub_test_A';
const SUB_B = 'sub_test_B';
const FUTURE_TRIAL_END = Math.floor(Date.now() / 1000) + 30 * 86400;

process.env.STRIPE_PRICE_COPILOT_LIST = 'price_copilot_list';
process.env.STRIPE_PRICE_COPILOT_FOUNDING = 'price_copilot_founding';
process.env.STRIPE_PRICE_AUTOPILOT_LIST = 'price_autopilot_list';
process.env.STRIPE_PRICE_AUTOPILOT_FOUNDING = 'price_autopilot_founding';
process.env.STRIPE_PRICE_COPILOT_OVERAGE = 'price_copilot_overage';
process.env.STRIPE_PRICE_AUTOPILOT_OVERAGE = 'price_autopilot_overage';

function providerSubscription(overrides: Record<string, unknown> = {}): any {
  return {
    id: SUB_ID,
    customer: CUSTOMER_ID,
    status: 'active',
    trial_end: null,
    items: {
      data: [{
        id: 'si_base',
        quantity: 1,
        metadata: {},
        price: { id: 'price_copilot_list', metadata: {} },
      }],
    },
    ...overrides,
  };
}

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

function successfulProjectionResults(): Array<unknown | (() => unknown)> {
  return [
    [{ id: ACCOUNT_ID }],
    [],
    [],
    [],
    () => [mockAccountState.row],
    [],
    ...tierMirrorSyncResults(),
    ...statusMirrorSyncResults(),
  ];
}

function changedProjectionResults(
  locationsPaid: number,
): Array<unknown | (() => unknown)> {
  return [
    [{ id: ACCOUNT_ID }],
    [],
    [],
    [],
    () => [mockAccountState.row],
    () => {
      mockAccountState.row.locations_paid = locationsPaid;
      return [{ id: ACCOUNT_ID }];
    },
    [],
    ...tierMirrorSyncResults(),
    ...statusMirrorSyncResults(),
  ];
}

function tierMirrorSyncResults(): Array<unknown | (() => unknown)> {
  return [
    [{ id: PRIMARY_BIZ }],
    [],
    () => [{
      subscription_tier: mockAccountState.row.subscription_tier,
    }],
    [],
  ];
}

function statusMirrorSyncResults(): Array<unknown | (() => unknown)> {
  return [
    [{ id: PRIMARY_BIZ }],
    [],
    () => [{
      subscription_status: mockAccountState.row.subscription_status,
      subscription_activated_at: null,
    }],
    [],
  ];
}

function beforeRowResults(): Array<unknown> {
  return [[{ id: ACCOUNT_ID }], [], [], []];
}

function throughLockedRowResults(): Array<unknown | (() => unknown)> {
  return [
    ...beforeRowResults(),
    () => [mockAccountState.row],
  ];
}

function statusOnlyProjectionResults(): Array<unknown | (() => unknown)> {
  return [
    ...beforeRowResults(),
    () => [mockAccountState.row],
    [],
    ...statusMirrorSyncResults(),
  ];
}

function setSqlQueue(...results: Array<unknown | (() => unknown)>): void {
  mockSqlQueue.splice(0, mockSqlQueue.length, ...results);
}

function sqlCalls(): Array<{ text: string; values: unknown[]; order: number }> {
  return mockSql.mock.calls.map((call: unknown[], index: number) => ({
    text: Array.from(call[0] as TemplateStringsArray).join('?'),
    values: call.slice(1),
    order: mockSql.mock.invocationCallOrder[index]!,
  }));
}

function statusTransition(overrides: Record<string, unknown> = {}) {
  return {
    accountResolved: true,
    fromStatus: 'pending_payment',
    toStatus: 'active',
    changed: true,
    activated: true,
    primaryBusinessId: PRIMARY_BIZ,
    ...overrides,
  };
}

beforeEach(() => {
  mockSql.mockClear();
  mockSql.begin.mockClear();
  Object.assign(mockAccountState.row, {
    id: ACCOUNT_ID,
    subscription_tier: 'copilot',
    subscription_status: 'active',
    price_variant: 'list',
    base_price_cents: 2900,
    locations_paid: 0,
    locations_overage_price_cents: 1500,
    locations_included: 1,
    stripe_subscription_id: null,
    stripe_customer_id: null,
  });
  mockApplyStripeSubscriptionState.mockReset();
  mockApplyStripeSubscriptionState.mockResolvedValue(statusTransition());
  mockResumePrimaryBusinessBackfill.mockClear();
  mockRetrieve.mockReset();
  mockRetrieve.mockResolvedValue(providerSubscription());
  mockReportCaughtError.mockReset();
  mockAutopilotPurchasable.mockReset();
  mockAutopilotPurchasable.mockReturnValue(true);
  setSqlQueue(...successfulProjectionResults());
});

afterEach(() => {
  expect(mockSqlQueue, 'every expected SQL result must be consumed by the branch').toHaveLength(0);
});

describe('checkout.session.completed — paid activation', () => {
  it('routes paid activation through the single status applier', async () => {
    await processCheckoutSessionCompleted(trialSession({ amount_total: 7900 }));
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledWith(
      expect.anything(),
      { mode: 'checkout', accountId: ACCOUNT_ID },
      expect.objectContaining({ id: SUB_ID, status: 'active' }),
    );
    expect(mockRetrieve).toHaveBeenCalledWith(SUB_ID);
    expect(mockSql).toHaveBeenCalledTimes(14);
  });

  it('changed activation resumes backfill, while replay no-op does not', async () => {
    await processCheckoutSessionCompleted(trialSession({ amount_total: 7900 }));
    expect(mockResumePrimaryBusinessBackfill).toHaveBeenCalledWith(PRIMARY_BIZ);

    setSqlQueue(...successfulProjectionResults());
    mockApplyStripeSubscriptionState.mockResolvedValueOnce(
      statusTransition({ fromStatus: 'active', changed: false, activated: false }),
    );
    mockResumePrimaryBusinessBackfill.mockClear();
    await processCheckoutSessionCompleted(trialSession({ amount_total: 7900 }));
    expect(mockResumePrimaryBusinessBackfill).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(28);
  });

  it('changed-false replay still repairs the deferred status and activation mirror', async () => {
    mockApplyStripeSubscriptionState.mockResolvedValueOnce(
      statusTransition({ fromStatus: 'active', changed: false, activated: false }),
    );

    await processCheckoutSessionCompleted(trialSession({ amount_total: 7900 }));

    const statusProjection = sqlCalls().filter(
      (call) => /UPDATE\s+businesses/.test(call.text) && /subscription_status/.test(call.text),
    );
    expect(statusProjection).toHaveLength(1);
    expect(statusProjection[0]!.text).toMatch(/subscription_activated_at\s*=\s*COALESCE/);
    expect(mockResumePrimaryBusinessBackfill).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(14);
  });
});

describe('checkout.session.completed — WS8 provider-current projection', () => {
  it('locks in fixed order before the row and persists trusted quantity', async () => {
    Object.assign(mockAccountState.row, {
      stripe_subscription_id: SUB_ID,
      stripe_customer_id: CUSTOMER_ID,
    });
    mockRetrieve.mockResolvedValue(providerSubscription({
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_copilot_list', metadata: {} },
          },
          {
            id: 'si_overage', quantity: 3,
            metadata: { billing_role: 'overage' },
            price: { id: 'price_copilot_overage', metadata: {} },
          },
        ],
      },
    }));
    setSqlQueue(...changedProjectionResults(3));

    await processCheckoutSessionCompleted(trialSession({ amount_total: 2900 }));

    const calls = sqlCalls();
    const lockCalls = calls.filter((call) => /pg_advisory_xact_lock/.test(call.text));
    expect(lockCalls.map((call) => call.values[0])).toEqual([
      `${ACCOUNT_ID}:tier_entitlement`,
      `${ACCOUNT_ID}:overage_sync`,
      `${ACCOUNT_ID}:activation`,
      `${ACCOUNT_ID}:tier_entitlement`,
      `${ACCOUNT_ID}:tier_entitlement`,
    ]);
    const lockedAccount = calls.find(
      (call) => /subscription_tier/.test(call.text) && /FOR\s+UPDATE/.test(call.text),
    );
    expect(lockedAccount).toBeDefined();
    expect(lockCalls[2]!.order).toBeLessThan(lockedAccount!.order);
    expect(mockRetrieve.mock.invocationCallOrder[0]).toBeLessThan(lockedAccount!.order);
    const snapshotWrite = calls.find(
      (call) => /UPDATE\s+accounts/.test(call.text) && /base_price_cents/.test(call.text),
    );
    expect(snapshotWrite!.values).toEqual(
      expect.arrayContaining(['copilot', 2900, 1500, 1, 3, ACCOUNT_ID]),
    );
    expect(calls.filter((call) => /INSERT\s+INTO\s+account_audit_log/.test(call.text))).toHaveLength(1);
    expect(mockAccountState.row.locations_paid).toBe(3);
    expect(mockSql).toHaveBeenCalledTimes(15);
  });

  it('preserves stored cents/quota when live registry changes and only quantity converges', async () => {
    Object.assign(mockAccountState.row, {
      base_price_cents: 2900,
      locations_overage_price_cents: 1500,
      locations_included: 1,
      stripe_subscription_id: SUB_ID,
      stripe_customer_id: CUSTOMER_ID,
    });
    const config = TIER_CONFIG[SubscriptionTier.COPILOT];
    const prices = config.baseByVariant as { list: number; founding: number };
    const original = {
      list: prices.list,
      overageCents: config.overageCents,
      included: config.included,
    };
    prices.list = 9999;
    config.overageCents = 8888;
    config.included = 7;
    mockRetrieve.mockResolvedValue(providerSubscription({
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_copilot_list', metadata: {} },
          },
          {
            id: 'si_overage', quantity: 4,
            metadata: { billing_role: 'overage' },
            price: { id: 'price_copilot_overage', metadata: {} },
          },
        ],
      },
    }));
    setSqlQueue(...changedProjectionResults(4));

    try {
      await processCheckoutSessionCompleted(trialSession({ amount_total: 2900 }));
    } finally {
      prices.list = original.list;
      config.overageCents = original.overageCents;
      config.included = original.included;
    }

    const snapshotWrite = sqlCalls().find(
      (call) => /UPDATE\s+accounts/.test(call.text) && /base_price_cents/.test(call.text),
    );
    expect(snapshotWrite!.values).toEqual(
      expect.arrayContaining(['copilot', 2900, 1500, 1, 4, ACCOUNT_ID]),
    );
    expect(snapshotWrite!.values).not.toEqual(expect.arrayContaining([9999, 8888, 7]));
    expect(sqlCalls().filter((call) => /INSERT\s+INTO\s+account_audit_log/.test(call.text))).toHaveLength(1);
    expect(mockAccountState.row.locations_paid).toBe(4);
    expect(mockSql).toHaveBeenCalledTimes(15);
  });

  it('replay repeats the same complete stored snapshot without cumulative math or audit', async () => {
    Object.assign(mockAccountState.row, {
      stripe_subscription_id: SUB_ID,
      stripe_customer_id: CUSTOMER_ID,
    });
    const subscription = providerSubscription({
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_copilot_list', metadata: {} },
          },
          {
            id: 'si_overage', quantity: 2,
            metadata: { billing_role: 'overage' },
            price: { id: 'price_copilot_overage', metadata: {} },
          },
        ],
      },
    });
    mockRetrieve.mockResolvedValue(subscription);
    mockApplyStripeSubscriptionState
      .mockResolvedValueOnce(statusTransition())
      .mockResolvedValueOnce(
        statusTransition({ fromStatus: 'active', changed: false, activated: false }),
      );
    setSqlQueue(...changedProjectionResults(2), ...successfulProjectionResults());

    await processCheckoutSessionCompleted(trialSession());
    await processCheckoutSessionCompleted(trialSession());

    const snapshotWrites = sqlCalls().filter(
      (call) => /UPDATE\s+accounts/.test(call.text) && /base_price_cents/.test(call.text),
    );
    expect(snapshotWrites).toHaveLength(2);
    expect(snapshotWrites[1]!.values).toEqual(snapshotWrites[0]!.values);
    expect(mockAccountState.row.locations_paid).toBe(2);
    expect(sqlCalls().filter((call) => /INSERT\s+INTO\s+account_audit_log/.test(call.text))).toHaveLength(1);
    expect(mockSql).toHaveBeenCalledTimes(29);
  });

  it('projects late Autopilot completion but alerts when Autopilot is no longer purchasable', async () => {
    Object.assign(mockAccountState.row, {
      subscription_tier: 'autopilot',
      price_variant: 'list',
      base_price_cents: 6900,
      locations_overage_price_cents: 2000,
      locations_included: 1,
      locations_paid: 0,
      stripe_subscription_id: SUB_ID,
      stripe_customer_id: CUSTOMER_ID,
    });
    mockAutopilotPurchasable.mockReturnValue(false);
    mockRetrieve.mockResolvedValue(providerSubscription({
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_autopilot_list', metadata: {} },
          },
          {
            id: 'si_overage', quantity: 2,
            metadata: { billing_role: 'overage' },
            price: { id: 'price_autopilot_overage', metadata: {} },
          },
        ],
      },
    }));
    setSqlQueue(...changedProjectionResults(2));

    await processCheckoutSessionCompleted(trialSession({ amount_total: 6900 }));

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    const calls = sqlCalls();
    const snapshotWrite = calls.find(
      (call) => /UPDATE\s+accounts/.test(call.text) && /base_price_cents/.test(call.text),
    );
    expect(snapshotWrite!.values).toEqual(
      expect.arrayContaining(['autopilot', 6900, 2000, 1, 2, ACCOUNT_ID]),
    );
    expect(calls.filter((call) => /INSERT\s+INTO\s+account_audit_log/.test(call.text))).toHaveLength(1);
    expect(mockReportCaughtError).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      {
        accountId: ACCOUNT_ID,
        subscriptionId: SUB_ID,
        reason: 'autopilot_activated_while_unavailable',
        priceId: 'price_autopilot_list',
      },
    );
    expect(mockAccountState.row.locations_paid).toBe(2);
    expect(mockSql).toHaveBeenCalledTimes(15);
    expect(mockSqlQueue).toHaveLength(0);
  });

  it('rejects reverse completion subB when the account is already bound to subA', async () => {
    Object.assign(mockAccountState.row, {
      stripe_subscription_id: SUB_A,
      stripe_customer_id: CUSTOMER_ID,
    });
    mockRetrieve.mockResolvedValue(providerSubscription({ id: SUB_B }));
    setSqlQueue(...throughLockedRowResults());

    await processCheckoutSessionCompleted(
      trialSession({ subscription: SUB_B }),
    );

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(sqlCalls().some((call) => /UPDATE\s+accounts/.test(call.text))).toBe(false);
    expect(sqlCalls().some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'bound_subscription_mismatch' }),
    );
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('rejects stale subA replay after the account has converged on subB', async () => {
    Object.assign(mockAccountState.row, {
      stripe_subscription_id: SUB_B,
      stripe_customer_id: CUSTOMER_ID,
    });
    mockRetrieve.mockResolvedValue(providerSubscription({ id: SUB_A }));
    setSqlQueue(...throughLockedRowResults());

    await processCheckoutSessionCompleted(
      trialSession({ subscription: SUB_A }),
    );

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(
      sqlCalls().some(
        (call) => /UPDATE\s+accounts/.test(call.text) && /locations_paid/.test(call.text),
      ),
    ).toBe(false);
    expect(sqlCalls().some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('rejects provider customer drift against the bound account before mutation', async () => {
    Object.assign(mockAccountState.row, {
      stripe_subscription_id: SUB_ID,
      stripe_customer_id: CUSTOMER_ID,
    });
    mockRetrieve.mockResolvedValue(providerSubscription({ customer: 'cus_other' }));
    setSqlQueue(...throughLockedRowResults());

    await processCheckoutSessionCompleted(
      trialSession({ customer: 'cus_other' }),
    );

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(sqlCalls().some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'bound_customer_mismatch' }),
    );
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('preserves a founding variant mismatch but still applies status for the bound subscription', async () => {
    Object.assign(mockAccountState.row, {
      price_variant: 'founding',
      stripe_subscription_id: SUB_ID,
      stripe_customer_id: CUSTOMER_ID,
    });
    mockApplyStripeSubscriptionState.mockImplementationOnce(async (tx: any) => {
      await tx`UPDATE accounts SET subscription_status = 'active' WHERE id = ${ACCOUNT_ID}::uuid`;
      return statusTransition();
    });
    setSqlQueue(...statusOnlyProjectionResults());

    await processCheckoutSessionCompleted(trialSession({ amount_total: 2900 }));

    const calls = sqlCalls();
    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => /subscription_status/.test(call.text))).toBe(true);
    expect(
      calls.some(
        (call) =>
          /UPDATE\s+accounts/.test(call.text) &&
          /(subscription_tier|price_variant|base_price_cents|locations_overage_price_cents|locations_included|locations_paid)/.test(call.text),
      ),
    ).toBe(false);
    expect(
      calls.some(
        (call) => /UPDATE\s+businesses/.test(call.text) && /subscription_tier/.test(call.text),
      ),
    ).toBe(false);
    expect(
      calls.some(
        (call) => /UPDATE\s+businesses/.test(call.text) && /subscription_status/.test(call.text),
      ),
    ).toBe(true);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'variant_or_tier_mismatch' }),
    );
    expect(mockSql).toHaveBeenCalledTimes(10);
  });

  it('rejects a correct base plus the other tier overage as status-only', async () => {
    Object.assign(mockAccountState.row, {
      stripe_subscription_id: SUB_ID,
      stripe_customer_id: CUSTOMER_ID,
    });
    mockApplyStripeSubscriptionState.mockImplementationOnce(async (tx: any) => {
      await tx`UPDATE accounts SET subscription_status = 'active' WHERE id = ${ACCOUNT_ID}::uuid`;
      return statusTransition();
    });
    mockRetrieve.mockResolvedValue(providerSubscription({
      items: {
        data: [
          {
            id: 'si_base', quantity: 1, metadata: {},
            price: { id: 'price_copilot_list', metadata: {} },
          },
          {
            id: 'si_wrong_overage', quantity: 2,
            metadata: { billing_role: 'overage' },
            price: { id: 'price_autopilot_overage', metadata: {} },
          },
        ],
      },
    }));
    setSqlQueue(...statusOnlyProjectionResults());

    await processCheckoutSessionCompleted(trialSession({ amount_total: 2900 }));

    expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
    expect(
      sqlCalls().some(
        (call) => /UPDATE\s+accounts/.test(call.text) && /base_price_cents/.test(call.text),
      ),
    ).toBe(false);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({
        reason: 'cross_tier_overage_price',
        priceId: 'price_autopilot_overage',
      }),
    );
    expect(mockSql).toHaveBeenCalledTimes(10);
  });

  it('provider retrieval failure consumes only lookup plus three locks and writes nothing', async () => {
    mockRetrieve.mockRejectedValueOnce(new Error('provider unavailable'));
    setSqlQueue(...beforeRowResults());

    await expect(
      processCheckoutSessionCompleted(trialSession({ amount_total: 2900 })),
    ).rejects.toThrow('provider unavailable');

    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(sqlCalls().some((call) => /FOR\s+UPDATE/.test(call.text))).toBe(false);
    expect(sqlCalls().some((call) => /UPDATE\s+accounts/.test(call.text))).toBe(false);
    expect(mockSql).toHaveBeenCalledTimes(4);
  });
});

describe('checkout.session.completed — trial start', () => {
  it.each(['paid', 'no_payment_required'] as const)(
    '%s zero-dollar trial routes provider-current trialing state through the applier',
    async (paymentStatus) => {
      mockRetrieve.mockResolvedValue(providerSubscription({
        status: 'trialing',
        trial_end: FUTURE_TRIAL_END,
      }));
      await processCheckoutSessionCompleted(trialSession({ payment_status: paymentStatus }));
      expect(mockApplyStripeSubscriptionState).toHaveBeenCalledTimes(1);
      expect(mockApplyStripeSubscriptionState.mock.calls[0]![1]).toEqual({
        mode: 'checkout', accountId: ACCOUNT_ID,
      });
      expect(mockApplyStripeSubscriptionState.mock.calls[0]![2]).toMatchObject({
        status: 'trialing', trial_end: FUTURE_TRIAL_END,
      });
    },
  );

  it('normal paid and zero-dollar non-trial both use provider-current active state', async () => {
    await processCheckoutSessionCompleted(trialSession({ amount_total: 7900 }));
    expect(mockApplyStripeSubscriptionState.mock.calls[0]![2]).toMatchObject({ status: 'active' });

    setSqlQueue(...successfulProjectionResults());
    await processCheckoutSessionCompleted(trialSession());
    expect(mockApplyStripeSubscriptionState.mock.calls[1]![2]).toMatchObject({ status: 'active' });
  });

  it('future trial activation resumes primary-business backfill', async () => {
    mockRetrieve.mockResolvedValue(providerSubscription({
      status: 'trialing', trial_end: FUTURE_TRIAL_END,
    }));
    await processCheckoutSessionCompleted(trialSession());
    expect(mockResumePrimaryBusinessBackfill).toHaveBeenCalledWith(PRIMARY_BIZ);
  });

  it('past trial end is rejected before the account row or applier', async () => {
    mockRetrieve.mockResolvedValue(providerSubscription({
      status: 'trialing',
      trial_end: Math.floor(Date.now() / 1000) - 86400,
    }));
    setSqlQueue(...beforeRowResults());
    await processCheckoutSessionCompleted(trialSession());
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(sqlCalls().some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    expect(mockSql).toHaveBeenCalledTimes(4);
  });

  it('session/provider customer mismatch is rejected before the account row', async () => {
    mockRetrieve.mockResolvedValue(providerSubscription({ customer: 'cus_other' }));
    setSqlQueue(...beforeRowResults());
    await processCheckoutSessionCompleted(trialSession());
    expect(mockApplyStripeSubscriptionState).not.toHaveBeenCalled();
    expect(sqlCalls().some((call) => /UPDATE\s+businesses/.test(call.text))).toBe(false);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'ingress/stripe/checkout-completed',
      expect.any(Error),
      expect.objectContaining({ reason: 'customer_mismatch' }),
    );
    expect(mockSql).toHaveBeenCalledTimes(4);
  });
});
