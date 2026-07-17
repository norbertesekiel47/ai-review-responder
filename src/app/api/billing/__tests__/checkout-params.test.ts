import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

const {
  mockRequireRole,
  mockSql,
  mockGetOffboardingState,
  mockApplyTierSnapshot,
  mockStripeCreate,
} = vi.hoisted(() => {
  const mockSql = vi.fn() as ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
  };
  mockSql.begin = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback(mockSql),
  );
  return {
    mockRequireRole: vi.fn(),
    mockSql,
    mockGetOffboardingState: vi.fn(),
    mockApplyTierSnapshot: vi.fn(),
    mockStripeCreate: vi.fn(),
  };
});

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: mockRequireRole, AuthError };
});
vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('@/lib/account-offboarding/gate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/account-offboarding/gate')>()),
  getOffboardingState: mockGetOffboardingState,
}));
vi.mock('@/lib/payments/plan-activation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/plan-activation')>()),
  applyTierSnapshot: mockApplyTierSnapshot,
}));
vi.mock('@/lib/payments/stripe-client', () => ({
  getStripe: () => ({ checkout: { sessions: { create: mockStripeCreate } } }),
}));

import { POST } from '../checkout/route';
import { resetServerConfigForTests } from '@/lib/config/server';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';
const APP_URL = 'https://app.example.com';
const PRICE_ENV = {
  STRIPE_PRICE_COPILOT_LIST: 'price_copilot_list',
  STRIPE_PRICE_COPILOT_FOUNDING: 'price_copilot_founding',
  STRIPE_PRICE_AUTOPILOT_LIST: 'price_autopilot_list',
  STRIPE_PRICE_AUTOPILOT_FOUNDING: 'price_autopilot_founding',
  STRIPE_PRICE_COPILOT_OVERAGE: 'price_copilot_overage',
  STRIPE_PRICE_AUTOPILOT_OVERAGE: 'price_autopilot_overage',
} as const;

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`${APP_URL}/api/billing/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: APP_URL,
      host: 'app.example.com',
    },
    body: JSON.stringify(body),
  });
}

function account(onboardedBy: string | null = null) {
  return {
    id: ACCOUNT_ID,
    subscription_status: SubscriptionStatus.PENDING_PAYMENT,
    owner_email: 'owner@example.com',
    onboarded_by: onboardedBy,
  };
}

function queueAccountAndUsage(
  activeLocations: number,
  included: number,
  onboardedBy: string | null = null,
): void {
  const overageQuantity = Math.max(0, activeLocations - included);
  const trialEligible =
    process.env.TRIAL_ENABLED === 'true' &&
    process.env.SELF_SERVE_SIGNUP_ENABLED === 'true' &&
    onboardedBy === null;
  mockSql
    .mockResolvedValueOnce([account(onboardedBy)])
    .mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([{}])
    .mockResolvedValueOnce([{}])
    // createCheckoutSession locks the account in a separate SQL command before
    // taking the READ COMMITTED offboarding/attempt projection. Keep this row
    // distinct from the projection so removing or reordering the lock shifts
    // the strict queue and fails the parameter tests.
    .mockResolvedValueOnce([{ id: ACCOUNT_ID }])
    .mockResolvedValueOnce([{
      subscription_status: 'pending_payment',
      price_variant: 'list',
      checkout_attempt_id: ATTEMPT_ID,
      checkout_session_id: null,
      checkout_attempt_state: 'creating',
      checkout_attempt_tier: 'copilot',
      checkout_attempt_price_variant: 'list',
      checkout_attempt_base_price_id: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST,
      checkout_attempt_overage_price_id: PRICE_ENV.STRIPE_PRICE_COPILOT_OVERAGE,
      checkout_attempt_base_price_cents: 2900,
      checkout_attempt_overage_price_cents: 1500,
      checkout_attempt_locations_included: included,
      checkout_attempt_locations_paid: 0,
      checkout_attempt_overage_quantity: overageQuantity,
      checkout_attempt_trial_period_days: trialEligible ? 30 : null,
      checkout_attempt_tax_enabled: process.env.STRIPE_TAX_ENABLED === 'true',
      checkout_attempt_customer_email: 'owner@example.com',
      checkout_attempt_success_url:
        `${APP_URL}/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      checkout_attempt_cancel_url:
        `${APP_URL}/onboarding/pay?cancelled=true`,
    }])
    .mockResolvedValueOnce([{ id: ACCOUNT_ID }]);
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store, private');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({
    id: 'owner-1',
    role: 'owner',
    accountId: ACCOUNT_ID,
  });
  mockGetOffboardingState.mockResolvedValue(null);
  mockApplyTierSnapshot.mockResolvedValue({
    kind: 'ok',
    accountId: ACCOUNT_ID,
    variant: 'list',
    attemptId: ATTEMPT_ID,
  });
  mockStripeCreate.mockResolvedValue({
    id: 'cs_test_123',
    url: 'https://checkout.stripe.test/session',
    status: 'open',
  });
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
  vi.stubEnv('SELF_SERVE_SIGNUP_ENABLED', 'true');
  vi.stubEnv('TRIAL_ENABLED', 'false');
  vi.stubEnv('STRIPE_TAX_ENABLED', 'false');
  for (const [key, value] of Object.entries(PRICE_ENV)) vi.stubEnv(key, value);
  resetServerConfigForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerConfigForTests();
});

describe('POST /api/billing/checkout real Checkout parameters', () => {
  it('rejects an invalid account UUID before SQL, snapshot, or Stripe', async () => {
    const response = await POST(
      request({ accountId: 'not-a-uuid', tier: SubscriptionTier.COPILOT }),
    );
    expect(response.status).toBe(400);
    expectPrivateNoStore(response);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockStripeCreate).not.toHaveBeenCalled();
  });

  it('maps a new-attempt Price configuration failure to 502 without calling Stripe', async () => {
    vi.stubEnv('STRIPE_PRICE_COPILOT_LIST', '');
    mockSql.mockResolvedValueOnce([account()]);
    mockApplyTierSnapshot.mockRejectedValueOnce(
      new Error('Checkout Price configuration missing for copilot/list'),
    );

    const response = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(response.status).toBe(502);
    expectPrivateNoStore(response);
    expect((await response.json()).error).toBe('stripe_error');
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockApplyTierSnapshot).toHaveBeenCalledTimes(1);
    expect(mockStripeCreate).not.toHaveBeenCalled();
  });

  it('passes exact stored-quota overage quantity and disables promotion codes', async () => {
    queueAccountAndUsage(4, 1);

    const response = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    expect(mockSql).toHaveBeenCalledTimes(7);
    const sqlTexts = mockSql.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join('?'),
    );
    const accountLockIndex = sqlTexts.findIndex(
      (text) => text.includes('SELECT id')
        && text.includes('FROM accounts')
        && text.includes('FOR UPDATE'),
    );
    const attemptProjectionIndex = sqlTexts.findIndex((text) =>
      text.includes('a.checkout_attempt_id')
        && text.includes('ao.id AS offboarding_id')
        && text.includes('LEFT JOIN account_offboardings'),
    );
    const leaseBindIndex = sqlTexts.findIndex((text) =>
      text.includes('SET checkout_session_id'),
    );
    expect(accountLockIndex).toBeGreaterThanOrEqual(0);
    expect(attemptProjectionIndex).toBeGreaterThan(accountLockIndex);
    expect(leaseBindIndex).toBeGreaterThan(attemptProjectionIndex);
    expect(mockStripeCreate.mock.calls[0]![0]).toMatchObject({
      line_items: [
        { price: PRICE_ENV.STRIPE_PRICE_COPILOT_LIST, quantity: 1 },
        { price: PRICE_ENV.STRIPE_PRICE_COPILOT_OVERAGE, quantity: 3 },
      ],
      allow_promotion_codes: false,
    });
  });

  it('passes server-authoritative Stripe Tax parameters through the route', async () => {
    vi.stubEnv('STRIPE_TAX_ENABLED', 'true');
    resetServerConfigForTests();
    queueAccountAndUsage(1, 1);

    const response = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(response.status).toBe(200);
    expect(mockStripeCreate.mock.calls[0]![0]).toMatchObject({
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
    });
  });

  it('uses the locked 30-day trial only for eligible self-serve accounts', async () => {
    vi.stubEnv('TRIAL_ENABLED', 'true');
    resetServerConfigForTests();
    queueAccountAndUsage(1, 1);

    const response = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(response.status).toBe(200);
    expect(mockStripeCreate.mock.calls[0]![0].subscription_data).toEqual({
      trial_period_days: 30,
      metadata: { checkout_attempt_id: ATTEMPT_ID },
    });
  });

  it('excludes admin-provisioned accounts from a trial in the real Session parameters', async () => {
    vi.stubEnv('TRIAL_ENABLED', 'true');
    resetServerConfigForTests();
    queueAccountAndUsage(1, 1, 'admin-1');

    const response = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(response.status).toBe(200);
    expect(mockStripeCreate.mock.calls[0]![0].subscription_data).toEqual({
      metadata: { checkout_attempt_id: ATTEMPT_ID },
    });
  });

  it('creates paid Checkout for pending self-serve when self-serve signup is disabled', async () => {
    vi.stubEnv('TRIAL_ENABLED', 'true');
    vi.stubEnv('SELF_SERVE_SIGNUP_ENABLED', 'false');
    resetServerConfigForTests();
    queueAccountAndUsage(1, 1);

    const response = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );

    expect(response.status).toBe(200);
    expectPrivateNoStore(response);
    expect(mockSql).toHaveBeenCalledTimes(7);
    expect(mockApplyTierSnapshot).toHaveBeenCalledTimes(1);
    expect(mockStripeCreate).toHaveBeenCalledTimes(1);
    expect(mockStripeCreate.mock.calls[0]![0].subscription_data).toEqual({
      metadata: { checkout_attempt_id: ATTEMPT_ID },
    });
  });
});
