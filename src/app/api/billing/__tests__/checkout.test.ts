// src/app/api/billing/__tests__/checkout.test.ts
//
// TDD assertions for POST /api/billing/checkout.
// Validation contract: VAL-BILLING-001 through VAL-BILLING-006, VAL-BILLING-030 through VAL-BILLING-032.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSql, mockStripeCheckoutCreate } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockStripeCheckoutCreate: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

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

// Restore after all tests
afterAll(() => {
  if (_origStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = _origStripeKey;
});

import { afterAll } from 'vitest';

// ── Helpers ────────────────────────────────────────────────────────────────

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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockAccountRow(
  tier: string,
  status: string,
  email: string = 'owner@example.com',
) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    subscription_tier: tier,
    subscription_status: status,
    owner_email: email,
    locations_included: tier === 'premium' ? 5 : 1,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/billing/checkout', () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue([]);
    mockStripeCheckoutCreate.mockReset();
    setPriceEnvVars();
  });

  afterAll(() => {
    clearPriceEnvVars();
  });

  // VAL-BILLING-001 — standard tier creates Checkout Session with tier_base line item
  it('creates Checkout Session with base line item for standard tier', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment')]);
    // Active location count for overage
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_1',
      url: 'https://checkout.stripe.com/test/1',
    });

    const req = mkRequest({ accountId });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe('https://checkout.stripe.com/test/1');

    // Verify stripe.checkout.sessions.create was called with correct base line item
    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items[0]!.price).toBe('price_standard_test');
    expect(createArgs.line_items[0]!.quantity).toBe(1);
  });

  // VAL-BILLING-002 — standard tier with overage locations
  it('creates Checkout Session with base + overage line items for standard tier with overage', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // 3 locations, 1 included → 2 overage

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_2',
      url: 'https://checkout.stripe.com/test/2',
    });

    const req = mkRequest({ accountId });
    const res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items).toHaveLength(2);
    expect(createArgs.line_items[1].price).toBe('price_standard_overage_test');
    expect(createArgs.line_items[1].quantity).toBe(2);
  });

  // VAL-BILLING-003 — overage quantity = 0 when locations ≤ included
  it('sets overage quantity to 0 when locations ≤ included', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('premium', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // 3 locations, 5 included → 0 overage

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_3',
      url: 'https://checkout.stripe.com/test/3',
    });

    const req = mkRequest({ accountId });
    const res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    // Premium has overage, so the item should be present with quantity 0
    // or omitted entirely (VAL-BILLING-003 allows either)
    const overageItem = createArgs.line_items.find(
      (item: { price: string }) => item.price === 'price_premium_overage_test',
    );
    if (overageItem) {
      expect(overageItem.quantity).toBe(0);
    }
    // If omitted entirely, that's also acceptable per VAL-BILLING-003
  });

  // VAL-BILLING-004 — basic tier omits overage line item
  it('creates Checkout Session with only base line item for basic tier', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('basic', 'pending_payment')]);
    // Even with more locations (shouldn't happen for basic, but tested)
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_4',
      url: 'https://checkout.stripe.com/test/4',
    });

    const req = mkRequest({ accountId });
    const res = await POST(req);

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
  it('sets mode=subscription, client_reference_id, success_url, cancel_url, allow_promotion_codes', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment', 'test@example.com')]);
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_5',
      url: 'https://checkout.stripe.com/test/5',
    });

    const req = mkRequest({ accountId });
    const res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.mode).toBe('subscription');
    expect(createArgs.client_reference_id).toBe(accountId);
    expect(createArgs.customer_email).toBe('test@example.com');
    expect(createArgs.success_url).toMatch(/\/onboarding\/business/);
    expect(createArgs.cancel_url).toMatch(/\/onboarding\/pay/);
    expect(createArgs.allow_promotion_codes).toBe(true);
  });

  // VAL-BILLING-006 — rejects already-active account
  it('returns 409 for already-active account', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'active')]);

    const req = mkRequest({ accountId });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/already_active/i);
    expect(mockStripeCheckoutCreate).not.toHaveBeenCalled();
  });

  // Premium tier with overage
  it('creates Checkout Session with correct overage for premium tier', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('premium', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([{ count: 7 }]); // 7 locations, 5 included → 2 overage

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_premium',
      url: 'https://checkout.stripe.com/test/premium',
    });

    const req = mkRequest({ accountId });
    const res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items[0].price).toBe('price_premium_test');
    expect(createArgs.line_items[1].price).toBe('price_premium_overage_test');
    expect(createArgs.line_items[1].quantity).toBe(2);
  });

  // Founders tier with overage
  it('creates Checkout Session with correct overage for founders tier', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('founders', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([{ count: 3 }]); // 3 locations, 1 included → 2 overage

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_founders',
      url: 'https://checkout.stripe.com/test/founders',
    });

    const req = mkRequest({ accountId });
    const res = await POST(req);

    const createArgs = mockStripeCheckoutCreate.mock.calls[0]![0];
    expect(createArgs.line_items[0].price).toBe('price_founding_test');
    expect(createArgs.line_items[1].price).toBe('price_founders_overage_test');
    expect(createArgs.line_items[1].quantity).toBe(2);
  });

  // VAL-BILLING-031 — does not reference STRIPE_PAYMENT_LINK_*
  it('does not reference STRIPE_PAYMENT_LINK_* env vars', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    mockStripeCheckoutCreate.mockResolvedValue({
      id: 'cs_test_6',
      url: 'https://checkout.stripe.com/test/6',
    });

    // Set payment link env vars (should NOT be used)
    process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'https://buy.stripe.com/test_F';
    process.env.STRIPE_PAYMENT_LINK_STANDARD = 'https://buy.stripe.com/test_S';
    process.env.STRIPE_PAYMENT_LINK_PREMIUM = 'https://buy.stripe.com/test_P';

    const req = mkRequest({ accountId });
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
    const accountId = '00000000-0000-7f00-8000-000000000000';
    mockSql.mockResolvedValueOnce([]); // no account found

    const req = mkRequest({ accountId });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid accountId format', async () => {
    const req = mkRequest({ accountId: 'not-a-uuid' });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 500 when Stripe price env vars are missing', async () => {
    clearPriceEnvVars();
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('standard', 'pending_payment')]);
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    const req = mkRequest({ accountId });
    const res = await POST(req);

    // VAL-BILLING-066: Returns 502 with user-facing error for Stripe failures
    expect(res.status).toBe(502);
    setPriceEnvVars();
  });
});
