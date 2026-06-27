// src/app/api/billing/__tests__/checkout.test.ts
//
// TDD assertions for POST /api/billing/checkout.
// Validation contract: VAL-BILLING-001 through VAL-BILLING-006, VAL-BILLING-030 through VAL-BILLING-032.
// Security: requires owner auth, validates body.accountId === user.accountId.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockRequireRole, mockSql, mockStripeCheckoutCreate, mockGetOffboardingState } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSql: vi.fn(),
  mockStripeCheckoutCreate: vi.fn(),
  mockGetOffboardingState: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('@/lib/account-offboarding/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-offboarding/gate')>();
  return {
    ...actual,
    getOffboardingState: (...args: unknown[]) => mockGetOffboardingState(...args),
  };
});

// Mock Stripe SDK
vi.mock('stripe', () => {
  return {
    default: class FakeStripe {
      checkout = {
        sessions: { create: mockStripeCheckoutCreate },
      };
    },
  };
});

// Set env vars before importing the handler
const _origStripeKey = process.env.STRIPE_SECRET_KEY;
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

import { POST } from '../checkout/route';
import { AuthError } from '@/lib/db/auth';

// Restore after all tests
afterAll(() => {
  if (_origStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = _origStripeKey;
});

import { afterAll } from 'vitest';

// ── Helpers ────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ACCOUNT_ID = '99999999-8888-7777-6666-555555555555';
const USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';
const APP_URL = 'http://localhost:3000';

function setPriceEnvVars() {
  process.env.STRIPE_PRICE_BASIC = 'price_basic_test';
  process.env.STRIPE_PRICE_FOUNDING = 'price_founding_test';
  process.env.STRIPE_PRICE_FOUNDERS_OVERAGE = 'price_founders_overage_test';
  process.env.STRIPE_PRICE_STANDARD = 'price_standard_test';
  process.env.STRIPE_PRICE_STANDARD_OVERAGE = 'price_standard_overage_test';
  process.env.STRIPE_PRICE_PREMIUM = 'price_premium_test';
  process.env.STRIPE_PRICE_PREMIUM_OVERAGE = 'price_premium_overage_test';
}

function clearPriceEnvVars() {
  delete process.env.STRIPE_PRICE_BASIC;
  delete process.env.STRIPE_PRICE_FOUNDING;
  delete process.env.STRIPE_PRICE_FOUNDERS_OVERAGE;
  delete process.env.STRIPE_PRICE_STANDARD;
  delete process.env.STRIPE_PRICE_STANDARD_OVERAGE;
  delete process.env.STRIPE_PRICE_PREMIUM;
  delete process.env.STRIPE_PRICE_PREMIUM_OVERAGE;
}

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

function ownerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: 'bbbbbbbb-0000-0000-0000-000000000001',
    ...overrides,
  };
}

function mockAccountRow(
  tier: string,
  status: string,
  email: string = 'owner@example.com',
) {
  return {
    id: ACCOUNT_ID,
    subscription_tier: tier,
    subscription_status: status,
    owner_email: email,
    locations_included: tier === 'premium' ? 5 : 1,
  };
}

function mockCheckoutUsageRow(count: number, locationsIncluded: number) {
  return { count, locations_included: locationsIncluded };
}

function setupHappyPathMocks(
  tier: string = 'standard',
  status: string = 'pending_payment',
) {
  mockRequireRole.mockResolvedValueOnce(ownerUser());
  mockSql.mockResolvedValueOnce([mockAccountRow(tier, status)]);
  // Active location count for overage
  mockSql.mockResolvedValueOnce([
    mockCheckoutUsageRow(1, tier === 'premium' ? 5 : 1),
  ]);
  mockStripeCheckoutCreate.mockResolvedValue({
    id: 'cs_test_happy',
    url: 'https://checkout.stripe.com/test/happy',
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/billing/checkout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockReset();
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    mockGetOffboardingState.mockReset();
    mockGetOffboardingState.mockResolvedValue(null);
    mockStripeCheckoutCreate.mockReset();
    setPriceEnvVars();
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  afterAll(() => {
    clearPriceEnvVars();
  });

  // ── Auth & ownership ────────────────────────────────────────────────────

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Unauthorized', 401));

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-owner role', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has no accountId', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser({ accountId: null }));

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('No account associated with this user');
  });

  it('returns 403 when body.accountId does not match authenticated user', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({ accountId: OTHER_ACCOUNT_ID });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Account ID mismatch');
  });

  it('does not look up account when accountId mismatches', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({ accountId: OTHER_ACCOUNT_ID });
    await POST(req);
    // sql should not have been called for account lookup (only the
    // ownership check prevents the account query from running)
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── Business logic ─────────────────────────────────────────────────────

  // VAL-BILLING-001 — standard tier creates Checkout Session with tier_base line item
  it('creates Checkout Session with base line item for standard tier', async () => {
    setupHappyPathMocks('standard', 'pending_payment');

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.com/test/happy');

    // Verify stripe.checkout.sessions.create was called with correct base line item
    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items).toHaveLength(1);
    expect(createArgs.line_items[0]!.price).toBe('price_standard_test');
    expect(createArgs.line_items[0]!.quantity).toBe(1);
    expect(
      createArgs.line_items.some((item: { quantity: number }) => item.quantity === 0),
    ).toBe(false);
  });

  it('returns 403 without Stripe when checkout is blocked by account offboarding', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment')]);
    mockGetOffboardingState.mockResolvedValueOnce({
      id: 'offboarding-1',
      accountId: ACCOUNT_ID,
      mode: 'cancel_only',
      status: 'scheduled',
      failedStep: null,
      terminalAt: null,
      accessEndsAt: new Date('2026-07-01T00:00:00.000Z'),
      teardownStartedAt: null,
      purgeAfter: null,
      purgeStartedAt: null,
      purgeCancelledAt: null,
    });

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockStripeCheckoutCreate).not.toHaveBeenCalled();
  });

  // Regression: accounts.owner_email does not exist after migration 034.
  it('loads owner email by joining users instead of selecting accounts.owner_email', async () => {
    setupHappyPathMocks('standard', 'pending_payment');

    const req = mkRequest({ accountId: ACCOUNT_ID });
    await POST(req);

    const accountLookup = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(accountLookup).toMatch(/FROM\s+accounts\s+a/i);
    expect(accountLookup).toMatch(/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*a\.owner_user_id/i);
    expect(accountLookup).toMatch(/u\.email\s+AS\s+owner_email/i);
    expect(accountLookup).not.toMatch(/SELECT\s+id,\s*subscription_tier,\s*subscription_status,\s*owner_email/i);
  });

  // VAL-BILLING-002 — standard tier with overage locations
  it('creates Checkout Session with base + overage line items for standard tier with overage', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(3, 1)]); // 3 locations, 1 included → 2 overage

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_2',
      url: 'https://checkout.stripe.com/test/2',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const _res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items).toHaveLength(2);
    expect(createArgs.line_items[1].price).toBe('price_standard_overage_test');
    expect(createArgs.line_items[1].quantity).toBe(2);
  });

  it('uses stored included quota to omit standard overage line item', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([
      { ...mockAccountRow('standard', 'pending_payment'), locations_included: 3 },
    ]);
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(3, 3)]);

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_custom_quota_no_overage',
      url: 'https://checkout.stripe.com/test/custom-quota-no-overage',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID });
    await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items).toHaveLength(1);
    expect(createArgs.line_items[0].price).toBe('price_standard_test');
    expect(
      createArgs.line_items.some(
        (item: { price: string }) => item.price === 'price_standard_overage_test',
      ),
    ).toBe(false);
  });

  it('uses stored included quota for standard overage line item quantity', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([
      { ...mockAccountRow('standard', 'pending_payment'), locations_included: 3 },
    ]);
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(5, 3)]);

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_custom_quota_overage',
      url: 'https://checkout.stripe.com/test/custom-quota-overage',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID });
    await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items).toHaveLength(2);
    expect(createArgs.line_items[1].price).toBe('price_standard_overage_test');
    expect(createArgs.line_items[1].quantity).toBe(2);
  });

  // VAL-BILLING-003 — omit overage item when locations ≤ included
  it('omits overage line item when locations ≤ included', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('premium', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(3, 5)]); // 3 locations, 5 included → 0 overage

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_3',
      url: 'https://checkout.stripe.com/test/3',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const _res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(
      createArgs.line_items.some(
        (item: { price: string }) => item.price === 'price_premium_overage_test',
      ),
    ).toBe(false);
    expect(
      createArgs.line_items.some(
        (item: { quantity: number }) => item.quantity === 0,
      ),
    ).toBe(false);
  });

  // VAL-BILLING-004 — basic tier omits overage line item
  it('creates Checkout Session with only base line item for basic tier', async () => {
    setupHappyPathMocks('basic', 'pending_payment');
    // Even with more locations (shouldn't happen for basic, but tested)
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(1, 1)]);

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const _res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items).toHaveLength(1);
    expect(createArgs.line_items[0].price).toBe('price_basic_test');
    expect(createArgs.line_items[0].quantity).toBe(1);
    // No overage price should appear
    expect(
      createArgs.line_items.some(
        (item: { price: string }) => item.price.includes('overage'),
      ),
    ).toBe(false);
  });

  // VAL-BILLING-005 — mode, client_reference_id, success_url, cancel_url, allow_promotion_codes
  it('sets mode=subscription, client_reference_id, payment-success return URL, cancel_url, allow_promotion_codes', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment', 'test@example.com')]);
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(1, 1)]);

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_5',
      url: 'https://checkout.stripe.com/test/5',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const _res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.mode).toBe('subscription');
    expect(createArgs.client_reference_id).toBe(ACCOUNT_ID);
    expect(createArgs.customer_email).toBe('test@example.com');
    expect(createArgs.success_url).toBe(
      `${APP_URL}/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    );
    expect(createArgs.cancel_url).toMatch(/\/onboarding\/pay/);
    expect(createArgs.allow_promotion_codes).toBe(true);
  });

  // VAL-BILLING-006 — rejects already-active account
  it('returns 409 for already-active account', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'active')]);

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already_active/i);
    expect(mockStripeCheckoutCreate).not.toHaveBeenCalled();
  });

  // Premium tier with overage
  it('creates Checkout Session with correct overage for premium tier', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('premium', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(7, 5)]); // 7 locations, 5 included → 2 overage

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_premium',
      url: 'https://checkout.stripe.com/test/premium',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const _res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items[0].price).toBe('price_premium_test');
    expect(createArgs.line_items[1].price).toBe('price_premium_overage_test');
    expect(createArgs.line_items[1].quantity).toBe(2);
  });

  // Founders tier with overage
  it('creates Checkout Session with correct overage for founders tier', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('founders', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(3, 1)]); // 3 locations, 1 included → 2 overage

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_founders',
      url: 'https://checkout.stripe.com/test/founders',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const _res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items[0].price).toBe('price_founding_test');
    expect(createArgs.line_items[1].price).toBe('price_founders_overage_test');
    expect(createArgs.line_items[1].quantity).toBe(2);
  });

  // VAL-BILLING-031 — does not reference STRIPE_PAYMENT_LINK_*
  it('does not reference STRIPE_PAYMENT_LINK_* env vars', async () => {
    setupHappyPathMocks('standard', 'pending_payment');

    // Set payment link env vars (should NOT be used)
    process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'https://buy.stripe.com/test_F';
    process.env.STRIPE_PAYMENT_LINK_STANDARD = 'https://buy.stripe.com/test_S';
    process.env.STRIPE_PAYMENT_LINK_PREMIUM = 'https://buy.stripe.com/test_P';

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);

    // Checkout should still work without using payment links
    expect(res.status).toBe(200);
    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items[0].price).toBe('price_standard_test');

    // Cleanup
    delete process.env.STRIPE_PAYMENT_LINK_FOUNDING;
    delete process.env.STRIPE_PAYMENT_LINK_STANDARD;
    delete process.env.STRIPE_PAYMENT_LINK_PREMIUM;
  });

  it('returns 404 when account not found', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([]); // no account found

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid accountId format', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({ accountId: 'not-a-uuid' });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 502 when Stripe price env vars are missing', async () => {
    clearPriceEnvVars();
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([mockCheckoutUsageRow(1, 1)]);

    const req = mkRequest({ accountId: ACCOUNT_ID });
    const res = await POST(req);

    // VAL-BILLING-066: Returns 502 with user-facing error for Stripe failures
    expect(res.status).toBe(502);
    setPriceEnvVars();
  });
});
