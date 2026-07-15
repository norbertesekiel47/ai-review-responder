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
  type Ws8SubscriptionTier,
} from '@/lib/accounts/tier-config';

const { createMock, mockAssertTierPurchasable } = vi.hoisted(() => ({
  createMock: vi.fn(),
  mockAssertTierPurchasable: vi.fn(),
}));

vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({ checkout: { sessions: { create: createMock } } }),
}));
vi.mock('@/lib/payments/tier-purchasability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/tier-purchasability')>()),
  assertTierPurchasable: mockAssertTierPurchasable,
}));

import {
  CheckoutUnavailableError,
  createCheckoutSession,
} from '../create-checkout-session';
import { resetServerConfigForTests } from '@/lib/config/server';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
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

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  createMock.mockReset();
  createMock.mockResolvedValue({
    url: 'https://checkout.stripe.test/session',
    id: 'cs_123',
  });
  mockAssertTierPurchasable.mockReset();
  for (const [key, value] of Object.entries(PRICE_ENV)) vi.stubEnv(key, value);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
  vi.stubEnv('TRIAL_PERIOD_DAYS', '30');
  resetServerConfigForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfigForTests();
});

function queueUsage(activeLocations = 3, included = 1): void {
  harness.sqlReturnQueue.push(
    mkTaggedResult([{ count: activeLocations, locations_included: included }]),
  );
}

describe('createCheckoutSession price and quantity matrix', () => {
  const cases: Array<{
    tier: Ws8SubscriptionTier;
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
    it(`${testCase.tier}/${testCase.variant} uses exact base and tier overage Prices`, async () => {
      queueUsage(3, 1);

      await createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        testCase.tier,
        testCase.variant,
        'owner@example.com',
      );

      const params = createMock.mock.calls[0]![0];
      expect(params.line_items).toEqual([
        { price: testCase.base, quantity: 1 },
        { price: testCase.overage, quantity: 2 },
      ]);
      expect(params.allow_promotion_codes).toBe(false);
      expect(mockAssertTierPurchasable).toHaveBeenCalledWith(testCase.tier);
      expect(harness.sqlCalls).toHaveLength(1);
      expect(harness.sqlReturnQueue).toHaveLength(0);
    });
  }

  it('omits a zero-quantity overage item but never stores that provisional quantity', async () => {
    queueUsage(1, 1);
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      'owner@example.com',
    );
    expect(createMock.mock.calls[0]![0].line_items).toEqual([
      { price: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST, quantity: 1 },
    ]);
    expect(harness.sqlCalls[0]!.text).toMatch(/SELECT[\s\S]*COUNT\(b\.id\)/);
    expect(harness.sqlCalls.some((call) => /UPDATE\s+accounts/i.test(call.text))).toBe(false);
  });

  it('fails before SQL or Stripe when a required Price is missing', async () => {
    vi.stubEnv('STRIPE_PRICE_AUTOPILOT_FOUNDING', '');
    await expect(
      createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        SubscriptionTier.AUTOPILOT,
        'founding',
        'owner@example.com',
      ),
    ).rejects.toBeInstanceOf(CheckoutUnavailableError);
    expect(harness.sqlCalls).toHaveLength(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rechecks the Autopilot gate immediately before Stripe creation', async () => {
    queueUsage(1, 1);
    mockAssertTierPurchasable.mockImplementationOnce(() => {
      throw new Error('gate closed');
    });
    await expect(
      createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        SubscriptionTier.AUTOPILOT,
        'list',
        'owner@example.com',
      ),
    ).rejects.toThrow('gate closed');
    expect(harness.sqlCalls).toHaveLength(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reuses one Stripe idempotency key for an exact logical retry', async () => {
    queueUsage(3, 1);
    queueUsage(3, 1);

    const first = await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'founding',
      'owner@example.com',
      { trial: true },
    );
    const replay = await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'founding',
      'owner@example.com',
      { trial: true },
    );

    expect(replay).toEqual(first);
    expect(createMock).toHaveBeenCalledTimes(2);
    const firstKey = createMock.mock.calls[0]![1]!.idempotencyKey;
    const replayKey = createMock.mock.calls[1]![1]!.idempotencyKey;
    expect(firstKey).toBe(replayKey);
    expect(firstKey).toMatch(/^checkout-session:v1:[a-f0-9]{64}$/);
    expect(harness.sqlCalls).toHaveLength(2);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });

  it('changes the idempotency key for tier, variant, trial, or quantity mutations', async () => {
    for (const [active, included] of [
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
      [3, 1],
    ] as const) {
      queueUsage(active, included);
    }

    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      'owner@example.com',
    );
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.AUTOPILOT,
      'list',
      'owner@example.com',
    );
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'founding',
      'owner@example.com',
    );
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      'owner@example.com',
      { trial: true },
    );
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      'owner@example.com',
    );

    const keys = createMock.mock.calls.map((call) => call[1]!.idempotencyKey);
    expect(new Set(keys)).toHaveLength(5);
    expect(harness.sqlReturnQueue).toHaveLength(0);
  });
});

describe('createCheckoutSession trial and tax handling', () => {
  for (const tier of [
    SubscriptionTier.COPILOT,
    SubscriptionTier.AUTOPILOT,
  ] as const) {
    it(`adds the 30-day card-up-front trial to explicitly selected ${tier}`, async () => {
      queueUsage(1, 1);
      await createCheckoutSession(
        mockSql,
        ACCOUNT_ID,
        tier,
        'list',
        'owner@example.com',
        { trial: true },
      );
      expect(createMock.mock.calls[0]![0].subscription_data).toEqual({
        trial_period_days: 30,
      });
    });
  }

  it('keeps the locked trial at 30 days even if a stale duration override is present', async () => {
    vi.stubEnv('TRIAL_PERIOD_DAYS', '14');
    queueUsage(1, 1);
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      'owner@example.com',
      { trial: true },
    );
    expect(createMock.mock.calls[0]![0].subscription_data).toEqual({
      trial_period_days: 30,
    });
  });

  it('omits trial data when trial is false', async () => {
    queueUsage(1, 1);
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      'owner@example.com',
    );
    expect(createMock.mock.calls[0]![0].subscription_data).toBeUndefined();
  });

  it('adds configured Stripe Tax fields without enabling promotion codes', async () => {
    vi.stubEnv('STRIPE_TAX_ENABLED', 'true');
    resetServerConfigForTests();
    queueUsage(1, 1);
    await createCheckoutSession(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.COPILOT,
      'list',
      'owner@example.com',
    );
    const params = createMock.mock.calls[0]![0];
    expect(params.automatic_tax).toEqual({ enabled: true });
    expect(params.billing_address_collection).toBe('required');
    expect(params.tax_id_collection).toEqual({ enabled: true });
    expect(params.allow_promotion_codes).toBe(false);
  });
});
