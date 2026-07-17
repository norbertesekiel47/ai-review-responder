import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  mkTaggedResult,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import {
  SubscriptionTier,
  type PriceVariant,
  type SubscriptionTierValue,
} from '@/lib/accounts/tier-config';

const {
  createMock,
  retrieveSessionMock,
  expireSessionMock,
  retrieveSubscriptionMock,
  cancelSubscriptionMock,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  retrieveSessionMock: vi.fn(),
  expireSessionMock: vi.fn(),
  retrieveSubscriptionMock: vi.fn(),
  cancelSubscriptionMock: vi.fn(),
}));

vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({
    checkout: {
      sessions: {
        create: createMock,
        retrieve: retrieveSessionMock,
        expire: expireSessionMock,
      },
    },
    subscriptions: {
      retrieve: retrieveSubscriptionMock,
      cancel: cancelSubscriptionMock,
    },
  }),
}));
import {
  CheckoutOffboardingBlockedError,
  createCheckoutSession,
} from '../create-checkout-session';
import { CheckoutAttemptConflictError } from '../plan-activation';
import { resetServerConfigForTests } from '@/lib/config/server';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';
const ACTIVATION_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const SESSION_ID = 'cs_123';
const PRICE_ENV = {
  STRIPE_PRICE_COPILOT_LIST: 'price_copilot_list',
  STRIPE_PRICE_COPILOT_FOUNDING: 'price_copilot_founding',
  STRIPE_PRICE_AUTOPILOT_LIST: 'price_autopilot_list',
  STRIPE_PRICE_AUTOPILOT_FOUNDING: 'price_autopilot_founding',
  STRIPE_PRICE_COPILOT_OVERAGE: 'price_copilot_overage',
  STRIPE_PRICE_AUTOPILOT_OVERAGE: 'price_autopilot_overage',
} as const;

let harness: MockSqlHarness;
let mockSql: Sql;

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    url: 'https://checkout.stripe.test/session',
    status: 'open',
    subscription: null,
    ...overrides,
  };
}

function attemptRow(input: {
  tier?: SubscriptionTierValue;
  variant?: PriceVariant;
  state?: 'creating' | 'open' | 'completed' | 'remediated';
  sessionId?: string | null;
  overageQuantity?: number;
  attemptId?: string;
  subscriptionStatus?: string;
  trialPeriodDays?: 30 | null;
  taxEnabled?: boolean;
  customerEmail?: string;
  successUrl?: string;
  cancelUrl?: string;
} = {}) {
  const tier = input.tier ?? SubscriptionTier.COPILOT;
  const variant = input.variant ?? 'list';
  const autopilot = tier === SubscriptionTier.AUTOPILOT;
  return {
    subscription_status: input.subscriptionStatus ?? 'pending_payment',
    price_variant: variant,
    checkout_attempt_id: input.attemptId ?? ATTEMPT_ID,
    checkout_session_id: input.sessionId ?? null,
    checkout_attempt_state: input.state ?? 'creating',
    checkout_attempt_tier: tier,
    checkout_attempt_price_variant: variant,
    checkout_attempt_base_price_id: autopilot
      ? variant === 'founding'
        ? PRICE_ENV.STRIPE_PRICE_AUTOPILOT_FOUNDING
        : PRICE_ENV.STRIPE_PRICE_AUTOPILOT_LIST
      : variant === 'founding'
        ? PRICE_ENV.STRIPE_PRICE_COPILOT_FOUNDING
        : PRICE_ENV.STRIPE_PRICE_COPILOT_LIST,
    checkout_attempt_overage_price_id: autopilot
      ? PRICE_ENV.STRIPE_PRICE_AUTOPILOT_OVERAGE
      : PRICE_ENV.STRIPE_PRICE_COPILOT_OVERAGE,
    checkout_attempt_base_price_cents: autopilot
      ? variant === 'founding'
        ? 4900
        : 6900
      : variant === 'founding'
        ? 1900
        : 2900,
    checkout_attempt_overage_price_cents: autopilot ? 2000 : 1500,
    checkout_attempt_locations_included: 1,
    checkout_attempt_locations_paid: 0,
    checkout_attempt_overage_quantity: input.overageQuantity ?? 0,
    checkout_attempt_trial_period_days: input.trialPeriodDays ?? null,
    checkout_attempt_tax_enabled: input.taxEnabled ?? false,
    checkout_attempt_customer_email:
      input.customerEmail ?? 'owner@example.com',
    checkout_attempt_success_url:
      input.successUrl ??
      'https://frozen.example.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}',
    checkout_attempt_cancel_url:
      input.cancelUrl ?? 'https://frozen.example.com/onboarding/pay?cancelled=true',
  };
}

function options() {
  return {
    attemptId: ATTEMPT_ID,
    activationLockId: ACTIVATION_ID,
  };
}

function queueLocksAndAttempt(
  row: ReturnType<typeof attemptRow> & Record<string, unknown>,
): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult([{ id: ACCOUNT_ID }]),
    mkTaggedResult([row]),
  );
}

function queueCreate(row: ReturnType<typeof attemptRow>): void {
  queueLocksAndAttempt(row);
  harness.sqlReturnQueue.push(mkTaggedResult([{ id: ACCOUNT_ID }]));
}

function queueFailedBindResolution(
  row: Pick<
    ReturnType<typeof attemptRow>,
    'checkout_attempt_id' | 'checkout_session_id' | 'checkout_attempt_state'
  >,
): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult([{}]),
    mkTaggedResult([row]),
  );
}

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  createMock.mockReset();
  createMock.mockResolvedValue(session());
  retrieveSessionMock.mockReset();
  retrieveSessionMock.mockResolvedValue(session());
  expireSessionMock.mockReset();
  expireSessionMock.mockResolvedValue(session({ status: 'expired', url: null }));
  retrieveSubscriptionMock.mockReset();
  retrieveSubscriptionMock.mockResolvedValue({
    id: 'sub_stale',
    status: 'active',
  });
  cancelSubscriptionMock.mockReset();
  cancelSubscriptionMock.mockResolvedValue({ id: 'sub_stale', status: 'canceled' });
  for (const [key, value] of Object.entries(PRICE_ENV)) vi.stubEnv(key, value);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
  resetServerConfigForTests();
});

afterEach(() => {
  expect(
    harness.sqlReturnQueue,
    'every queued SQL result must be consumed by the branch under test',
  ).toHaveLength(0);
  vi.unstubAllEnvs();
  resetServerConfigForTests();
});

describe('createCheckoutSession authoritative attempt lease', () => {
  const cases: Array<{
    tier: SubscriptionTierValue;
    variant: PriceVariant;
    base: string;
    overage: string;
  }> = [
    {
      tier: SubscriptionTier.COPILOT,
      variant: 'list',
      base: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST,
      overage: PRICE_ENV.STRIPE_PRICE_COPILOT_OVERAGE,
    },
    {
      tier: SubscriptionTier.COPILOT,
      variant: 'founding',
      base: PRICE_ENV.STRIPE_PRICE_COPILOT_FOUNDING,
      overage: PRICE_ENV.STRIPE_PRICE_COPILOT_OVERAGE,
    },
    {
      tier: SubscriptionTier.AUTOPILOT,
      variant: 'list',
      base: PRICE_ENV.STRIPE_PRICE_AUTOPILOT_LIST,
      overage: PRICE_ENV.STRIPE_PRICE_AUTOPILOT_OVERAGE,
    },
    {
      tier: SubscriptionTier.AUTOPILOT,
      variant: 'founding',
      base: PRICE_ENV.STRIPE_PRICE_AUTOPILOT_FOUNDING,
      overage: PRICE_ENV.STRIPE_PRICE_AUTOPILOT_OVERAGE,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.tier}/${testCase.variant} creates from the exact leased Price snapshot`, async () => {
      queueCreate(
        attemptRow({
          tier: testCase.tier,
          variant: testCase.variant,
          overageQuantity: 2,
        }),
      );

      await createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        testCase.tier,
        testCase.variant,
        options(),
      );

      const params = createMock.mock.calls[0]![0];
      expect(params.line_items).toEqual([
        { price: testCase.base, quantity: 1 },
        { price: testCase.overage, quantity: 2 },
      ]);
      expect(params.allow_promotion_codes).toBe(false);
      expect(params.metadata).toEqual({ checkout_attempt_id: ATTEMPT_ID });
      expect(params.subscription_data.metadata).toEqual({
        checkout_attempt_id: ATTEMPT_ID,
      });
      expect(createMock.mock.calls[0]![1]).toEqual({
        idempotencyKey: `checkout-session-attempt:v1:${ATTEMPT_ID}`,
      });
      expect(harness.sqlCalls).toHaveLength(6);
    });
  }

  it('same-selection replay returns the already-open Session without creating another', async () => {
    queueLocksAndAttempt(
      attemptRow({ state: 'open', sessionId: SESSION_ID }),
    );

    const result = await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      options(),
    );

    expect(result).toEqual({
      url: 'https://checkout.stripe.test/session',
      sessionId: SESSION_ID,
    });
    expect(retrieveSessionMock).toHaveBeenCalledWith(SESSION_ID, {
      expand: ['line_items'],
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('rejects a stale attempt before Stripe creation', async () => {
    queueLocksAndAttempt(attemptRow({ attemptId: '99999999-2222-4333-8444-555555555555' }));

    await expect(
      createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        SubscriptionTier.COPILOT,
        'list',
        options(),
      ),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);
    expect(createMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('does not create a Session if canonical status changed after plan selection', async () => {
    queueLocksAndAttempt(attemptRow({ subscriptionStatus: 'cancelled' }));

    await expect(
      createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        SubscriptionTier.COPILOT,
        'list',
        options(),
      ),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);
    expect(createMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('creates no provider Session when offboarding starts after attempt freeze', async () => {
    queueLocksAndAttempt({
      ...attemptRow(),
      offboarding_id: '22222222-3333-4444-8555-666666666666',
      offboarding_account_id: ACCOUNT_ID,
      offboarding_mode: 'delete_data',
      offboarding_status: 'pending',
      offboarding_failed_step: null,
      offboarding_access_ends_at: null,
      offboarding_teardown_started_at: null,
      offboarding_purge_after: null,
      offboarding_purge_started_at: null,
      offboarding_purge_cancelled_at: null,
    });

    await expect(
      createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        SubscriptionTier.COPILOT,
        'list',
        options(),
      ),
    ).rejects.toBeInstanceOf(CheckoutOffboardingBlockedError);

    expect(createMock).not.toHaveBeenCalled();
    expect(retrieveSessionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls[3]!.text).toContain('FOR UPDATE');
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('honors an already-authorized creating attempt after live gate drift', async () => {
    vi.stubEnv('AUTOPILOT_PURCHASABLE', 'false');
    queueCreate(attemptRow({ tier: SubscriptionTier.AUTOPILOT }));

    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.AUTOPILOT,
      'list',
      options(),
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]![0].line_items[0]).toEqual({
      price: PRICE_ENV.STRIPE_PRICE_AUTOPILOT_LIST,
      quantity: 1,
    });
    expect(harness.sqlCalls).toHaveLength(6);
  });

  it('omits a zero-quantity overage item', async () => {
    queueCreate(attemptRow({ overageQuantity: 0 }));
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      options(),
    );
    expect(createMock.mock.calls[0]![0].line_items).toEqual([
      { price: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST, quantity: 1 },
    ]);
  });

  it('uses the frozen attempt Prices when the live Price map drifts', async () => {
    vi.stubEnv('STRIPE_PRICE_AUTOPILOT_FOUNDING', '');
    vi.stubEnv('STRIPE_PRICE_AUTOPILOT_OVERAGE', 'price_new_overage');
    queueCreate(
      attemptRow({
        tier: SubscriptionTier.AUTOPILOT,
        variant: 'founding',
        overageQuantity: 2,
      }),
    );

    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.AUTOPILOT,
      'founding',
      options(),
    );

    expect(createMock.mock.calls[0]![0].line_items).toEqual([
      { price: 'price_autopilot_founding', quantity: 1 },
      { price: 'price_autopilot_overage', quantity: 2 },
    ]);
  });
});

describe('createCheckoutSession provider compensation', () => {
  it('expires a created Session with a stable key when lease binding fails', async () => {
    queueLocksAndAttempt(attemptRow());
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    queueFailedBindResolution(attemptRow());
    harness.sqlReturnQueue.push(mkTaggedResult([]));

    await expect(
      createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        SubscriptionTier.COPILOT,
        'list',
        options(),
      ),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);

    expect(expireSessionMock).toHaveBeenCalledWith(
      SESSION_ID,
      {},
      {
        idempotencyKey: `checkout-attempt-compensate-expire:v1:${SESSION_ID}`,
      },
    );
    const remediation = harness.sqlCalls.at(-1)!;
    expect(remediation.text).toMatch(/checkout_attempt_state\s*=\s*'remediated'/);
    expect(remediation.values).toEqual(
      expect.arrayContaining([SESSION_ID, ACCOUNT_ID, ATTEMPT_ID]),
    );
    expect(harness.sqlCalls).toHaveLength(11);
  });

  it('recovers an acknowledged lease after an ambiguous commit without expiring it', async () => {
    queueCreate(attemptRow());
    queueFailedBindResolution(
      attemptRow({ state: 'open', sessionId: SESSION_ID }),
    );
    const normalBegin = harness.mockSql.begin.getMockImplementation()!;
    harness.mockSql.begin
      .mockImplementationOnce(async (callback: unknown) => {
        await (callback as (tx: unknown) => Promise<unknown>)(harness.mockSql);
        throw new Error('commit acknowledgement lost');
      })
      .mockImplementation(normalBegin);

    const result = await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      options(),
    );

    expect(result.sessionId).toBe(SESSION_ID);
    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
    expect(harness.sqlCalls).toHaveLength(10);
  });

  it('cancels a subscription if completion wins the bind-failure compensation race', async () => {
    queueLocksAndAttempt(attemptRow());
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    queueFailedBindResolution(attemptRow());
    harness.sqlReturnQueue.push(mkTaggedResult([]));
    retrieveSessionMock.mockResolvedValueOnce(
      session({ status: 'complete', subscription: 'sub_stale' }),
    );

    await expect(
      createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        SubscriptionTier.COPILOT,
        'list',
        options(),
      ),
    ).rejects.toBeInstanceOf(CheckoutAttemptConflictError);

    expect(expireSessionMock).not.toHaveBeenCalled();
    expect(cancelSubscriptionMock).toHaveBeenCalledWith(
      'sub_stale',
      { invoice_now: false, prorate: false },
      {
        idempotencyKey: 'checkout-attempt-compensate-cancel:v1:sub_stale',
      },
    );
    expect(harness.sqlCalls).toHaveLength(11);
  });
});

describe('createCheckoutSession trial and tax shape', () => {
  it('keeps the locked 30-day trial and attempt metadata', async () => {
    vi.stubEnv('TRIAL_PERIOD_DAYS', '14');
    queueCreate(attemptRow({ trialPeriodDays: 30 }));
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      options(),
    );
    expect(createMock.mock.calls[0]![0].subscription_data).toEqual({
      trial_period_days: 30,
      metadata: { checkout_attempt_id: ATTEMPT_ID },
    });
  });

  it('uses the frozen Stripe Tax shape without enabling promotion codes', async () => {
    queueCreate(attemptRow({ taxEnabled: true }));
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      options(),
    );
    const params = createMock.mock.calls[0]![0];
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.billing_address_collection).toBe('required');
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.allow_promotion_codes).toBe(false);
  });

  it('reuses byte-stable stored create parameters across env and email drift', async () => {
    const frozen = attemptRow({
      trialPeriodDays: 30,
      taxEnabled: false,
      customerEmail: 'frozen-owner@example.com',
      successUrl:
        'https://old-deploy.example/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://old-deploy.example/onboarding/pay?cancelled=true',
    });
    queueCreate(frozen);
    queueCreate(frozen);

    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      options(),
    );
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://new-deploy.example');
    vi.stubEnv('STRIPE_TAX_ENABLED', 'true');
    resetServerConfigForTests();
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      options(),
    );

    const [first, second] = createMock.mock.calls.map(([params]) => params);
    expect(second).toEqual(first);
    expect(second).toMatchObject({
      customer_email: 'frozen-owner@example.com',
      success_url:
        'https://old-deploy.example/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://old-deploy.example/onboarding/pay?cancelled=true',
      subscription_data: {
        trial_period_days: 30,
        metadata: { checkout_attempt_id: ATTEMPT_ID },
      },
    });
    expect(second).not.toHaveProperty('automatic_tax');
    expect(createMock.mock.calls[0]![1]).toEqual(createMock.mock.calls[1]![1]);
  });
});
