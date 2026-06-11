// src/app/api/billing/tier-change/__tests__/route.test.ts
//
// TDD assertions for POST /api/billing/tier-change.
// Security: requires owner auth, validates body.accountId === user.accountId.
// Validates cross-account rejection and anonymous rejection.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockRequireRole, mockGetOffboardingState } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
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

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  return { mockSql: sqlFn };
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

// Mock validateTierChange
const { mockValidateTierChange } = vi.hoisted(() => ({
  mockValidateTierChange: vi.fn(),
}));

vi.mock('@/lib/accounts/tier-change', () => ({
  validateTierChange: mockValidateTierChange,
}));

// Mock getAccountOwnerUserId
const { mockGetAccountOwnerUserId } = vi.hoisted(() => ({
  mockGetAccountOwnerUserId: vi.fn(),
}));

vi.mock('@/lib/accounts/repo', () => ({
  getAccountById: vi.fn(),
  getAccountOwnerUserId: mockGetAccountOwnerUserId,
}));

// Mock Stripe SDK
const { mockSubscriptionsRetrieve, mockSubscriptionItemsUpdate, mockSubscriptionItemsCreate, mockSubscriptionItemsDel } = vi.hoisted(() => ({
  mockSubscriptionsRetrieve: vi.fn(),
  mockSubscriptionItemsUpdate: vi.fn(),
  mockSubscriptionItemsCreate: vi.fn(),
  mockSubscriptionItemsDel: vi.fn(),
}));

vi.mock('stripe', () => {
  return {
    default: class FakeStripe {
      subscriptions = {
        retrieve: mockSubscriptionsRetrieve,
      };
      subscriptionItems = {
        update: mockSubscriptionItemsUpdate,
        create: mockSubscriptionItemsCreate,
        del: mockSubscriptionItemsDel,
      };
      billingPortal = {
        sessions: { create: vi.fn() },
        configurations: { list: vi.fn(), create: vi.fn() },
      };
      checkout = {
        sessions: { create: vi.fn() },
      };
    },
  };
});

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_PRICE_STANDARD = 'price_standard_test';
process.env.STRIPE_PRICE_STANDARD_OVERAGE = 'price_standard_overage_test';
process.env.STRIPE_PRICE_PREMIUM = 'price_premium_test';
process.env.STRIPE_PRICE_PREMIUM_OVERAGE = 'price_premium_overage_test';
process.env.STRIPE_PRICE_BASIC = 'price_basic_test';
process.env.STRIPE_PRICE_FOUNDING = 'price_founding_test';
process.env.STRIPE_PRICE_FOUNDERS_OVERAGE = 'price_founders_overage_test';

import { POST } from '../route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ACCOUNT_ID = '99999999-8888-7777-6666-555555555555';
const USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';
const SUBSCRIPTION_ID = 'sub_test123';
const BASE_ITEM_ID = 'si_base_test';
const OVERAGE_ITEM_ID = 'si_overage_test';
const APP_URL = 'http://localhost:3000';

function mkRequest(body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/billing/tier-change', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: APP_URL, ...extraHeaders },
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

function setupHappyPathMocks() {
  mockRequireRole.mockResolvedValueOnce(ownerUser());
  mockValidateTierChange.mockResolvedValueOnce({
    allowed: true,
    newBillingPreview: {
      basePriceCents: 7900,
      overagePriceCents: 2500,
      overageUnits: 0,
      totalCents: 7900,
    },
  });
  mockSql.mockResolvedValueOnce([{
    stripe_subscription_id: SUBSCRIPTION_ID,
    subscription_tier: 'standard',
  }]);
  mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
  mockSubscriptionsRetrieve.mockResolvedValueOnce({
    items: {
      data: [
        { id: BASE_ITEM_ID, quantity: 1, price: { id: 'price_standard_test' } },
      ],
    },
  });
  mockSubscriptionItemsUpdate.mockResolvedValueOnce({});
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockReset();
  mockGetOffboardingState.mockReset();
  mockGetOffboardingState.mockResolvedValue(null);
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockValidateTierChange.mockReset();
  mockGetAccountOwnerUserId.mockReset();
  mockSubscriptionsRetrieve.mockReset();
  mockSubscriptionItemsUpdate.mockReset();
  mockSubscriptionItemsCreate.mockReset();
  mockSubscriptionItemsDel.mockReset();
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/billing/tier-change', () => {
  // ── Auth & ownership ────────────────────────────────────────────────────

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Unauthorized', 401));

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-owner role', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has no accountId', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser({ accountId: null }));

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('No account associated with this user');
  });

  it('returns 403 when body.accountId does not match authenticated user (cross-account)', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({ accountId: OTHER_ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Account ID mismatch');
  });

  it('does not call validateTierChange when accountId mismatches', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({ accountId: OTHER_ACCOUNT_ID, newTier: 'premium' });
    await POST(req);
    expect(mockValidateTierChange).not.toHaveBeenCalled();
  });

  it('blocks tier changes before validation when account offboarding forbids billing expansion', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
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

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockValidateTierChange).not.toHaveBeenCalled();
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  // ── Business logic ─────────────────────────────────────────────────────

  it('returns 409 when tier change is not allowed (same_tier)', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: false,
      reason: 'same_tier',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'standard' });
    const res = await POST(req);
    expect(res.status).toBe(409);
  });

  it('returns 409 when tier change is not allowed (basic_requires_single_location)', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: false,
      reason: 'basic_requires_single_location',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'basic' });
    const res = await POST(req);
    expect(res.status).toBe(409);
  });

  it('returns 409 when tier change is not allowed (subscription_inactive)', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: false,
      reason: 'subscription_inactive',
    });

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(409);
  });

  it('returns 400 when account has no Stripe subscription', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: { basePriceCents: 19900, overagePriceCents: 0, overageUnits: 0, totalCents: 19900 },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: null,
      subscription_tier: 'standard',
    }]);

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('no_stripe_subscription');
  });

  it('returns 400 for invalid accountId format', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({ accountId: 'not-a-uuid', newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid newTier', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'nonexistent_tier' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 200 with success and new billing on valid tier change', async () => {
    setupHappyPathMocks();

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.newTier).toBe('premium');
    expect(body.newBilling).toBeDefined();
    expect(body.newBilling.basePriceCents).toBe(7900);
  });

  it('calls stripe.subscriptionItems.update with new base price', async () => {
    setupHappyPathMocks();

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    await POST(req);

    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      BASE_ITEM_ID,
      expect.objectContaining({
        price: 'price_premium_test',
        proration_behavior: 'create_prorations',
      }),
      expect.any(Object),
    );
  });

  it('uses the request idempotency key for all Stripe tier-change mutations', async () => {
    setupHappyPathMocks();

    const req = mkRequest(
      { accountId: ACCOUNT_ID, newTier: 'premium' },
      { 'Idempotency-Key': 'tier-op-123' },
    );
    await POST(req);

    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      BASE_ITEM_ID,
      expect.objectContaining({
        price: 'price_premium_test',
      }),
      expect.objectContaining({
        idempotencyKey: `tier-change:${ACCOUNT_ID}:tier-op-123:base`,
      }),
    );
  });

  it('previews the billing change without mutating Stripe or account rows', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: {
        basePriceCents: 19900,
        overagePriceCents: 2000,
        overageUnits: 0,
        totalCents: 19900,
      },
    });

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium', preview: true });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      preview: true,
      newTier: 'premium',
      newBilling: {
        basePriceCents: 19900,
        overageUnits: 0,
      },
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
  });

  it('finds the base item by price and deletes stale overage when the new tier has zero overage units', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: {
        basePriceCents: 19900,
        overagePriceCents: 2000,
        overageUnits: 0,
        totalCents: 19900,
      },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: SUBSCRIPTION_ID,
      subscription_tier: 'standard',
    }]);
    mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
    mockSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: OVERAGE_ITEM_ID, quantity: 1, price: { id: 'price_standard_overage_test' } },
          { id: BASE_ITEM_ID, quantity: 1, price: { id: 'price_standard_test' } },
        ],
      },
    });
    mockSubscriptionItemsUpdate.mockResolvedValueOnce({});
    mockSubscriptionItemsDel.mockResolvedValueOnce({});

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      BASE_ITEM_ID,
      expect.objectContaining({
        price: 'price_premium_test',
        proration_behavior: 'create_prorations',
      }),
      expect.any(Object),
    );
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalledWith(
      OVERAGE_ITEM_ID,
      expect.anything(),
    );
    expect(mockSubscriptionItemsDel).toHaveBeenCalledWith(OVERAGE_ITEM_ID, {}, expect.any(Object));
  });

  it('does not update an unknown quantity-one item when no configured base price matches', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: {
        basePriceCents: 19900,
        overagePriceCents: 0,
        overageUnits: 0,
        totalCents: 19900,
      },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: SUBSCRIPTION_ID,
      subscription_tier: 'standard',
    }]);
    mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
    mockSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: 'si_setup_fee', quantity: 1, price: { id: 'price_legacy_setup_fee' } },
          { id: OVERAGE_ITEM_ID, quantity: 2, price: { id: 'price_standard_overage_test' } },
        ],
      },
    });

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('base_item_not_found');
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(mockSql.begin).not.toHaveBeenCalled();
  });

  it('updates existing overage item price and quantity when overage units remain', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: {
        basePriceCents: 7900,
        overagePriceCents: 2500,
        overageUnits: 2,
        totalCents: 12900,
      },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: SUBSCRIPTION_ID,
      subscription_tier: 'premium',
    }]);
    mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
    mockSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: BASE_ITEM_ID, quantity: 1, price: { id: 'price_premium_test' } },
          { id: OVERAGE_ITEM_ID, quantity: 1, price: { id: 'price_premium_overage_test' } },
        ],
      },
    });
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'standard' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      OVERAGE_ITEM_ID,
      expect.objectContaining({
        price: 'price_standard_overage_test',
        quantity: 2,
        proration_behavior: 'create_prorations',
      }),
      expect.any(Object),
    );
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
  });

  it('touches no overage item when none matches and zero overage units are needed', async () => {
    // Regression: the old `?? find(item => item.id !== baseItem.id)` fallback
    // would grab an arbitrary non-base item (e.g. a setup fee or credit) and
    // delete it. With findOverageItem there is no overage match, and with zero
    // overage units required, the route must not delete/create/re-price anything.
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: {
        basePriceCents: 19900,
        overagePriceCents: 0,
        overageUnits: 0,
        totalCents: 19900,
      },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: SUBSCRIPTION_ID,
      subscription_tier: 'standard',
      locations_overage_price_cents: 2500,
    }]);
    mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
    mockSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: BASE_ITEM_ID, quantity: 1, price: { id: 'price_standard_test' } },
          // A non-base, non-overage item (e.g. a one-time credit). Must NOT be deleted.
          { id: 'si_unrelated_credit', quantity: 1, price: { id: 'price_unrelated_credit', unit_amount: 500 } },
        ],
      },
    });
    mockSubscriptionItemsUpdate.mockResolvedValueOnce({});

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    // Base swap still happens.
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      BASE_ITEM_ID,
      expect.objectContaining({ price: 'price_premium_test' }),
      expect.any(Object),
    );
    // No overage operation on the unrelated item.
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalledWith(
      'si_unrelated_credit',
      expect.anything(),
      expect.anything(),
    );
  });

  it('creates an overage item at the target tier env price when none matches and overage units are needed', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: {
        basePriceCents: 19900,
        overagePriceCents: 2000,
        overageUnits: 3,
        totalCents: 25900,
      },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: SUBSCRIPTION_ID,
      subscription_tier: 'standard',
      locations_overage_price_cents: 2500,
    }]);
    mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
    mockSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: BASE_ITEM_ID, quantity: 1, price: { id: 'price_standard_test' } },
          // No overage item present.
        ],
      },
    });
    mockSubscriptionItemsUpdate.mockResolvedValueOnce({});
    mockSubscriptionItemsCreate.mockResolvedValueOnce({});

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSubscriptionItemsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: SUBSCRIPTION_ID,
        price: 'price_premium_overage_test',
        quantity: 3,
        proration_behavior: 'create_prorations',
      }),
      expect.any(Object),
    );
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
  });

  it('returns 500 and does NOT mutate the base item when the target tier overage env is missing', async () => {
    // Regression: the missing-overage-env case used to be silently no-op'd AFTER
    // the base price had already been swapped. The env presence check must run
    // BEFORE the first Stripe mutation, so the base item is never touched.
    const savedPremiumOverage = process.env.STRIPE_PRICE_PREMIUM_OVERAGE;
    delete process.env.STRIPE_PRICE_PREMIUM_OVERAGE;
    try {
      mockRequireRole.mockResolvedValueOnce(ownerUser());
      mockValidateTierChange.mockResolvedValueOnce({
        allowed: true,
        newBillingPreview: {
          basePriceCents: 19900,
          overagePriceCents: 2000,
          overageUnits: 3,
          totalCents: 25900,
        },
      });
      mockSql.mockResolvedValueOnce([{
        stripe_subscription_id: SUBSCRIPTION_ID,
        subscription_tier: 'standard',
        locations_overage_price_cents: 2500,
      }]);
      mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
      mockSubscriptionsRetrieve.mockResolvedValueOnce({
        items: {
          data: [
            { id: BASE_ITEM_ID, quantity: 1, price: { id: 'price_standard_test' } },
          ],
        },
      });

      const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('missing_price_config');
      // The base mutation must NOT have happened.
      expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
      expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
      expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
    } finally {
      if (savedPremiumOverage === undefined) delete process.env.STRIPE_PRICE_PREMIUM_OVERAGE;
      else process.env.STRIPE_PRICE_PREMIUM_OVERAGE = savedPremiumOverage;
    }
  });

  it('inserts account_audit_log on successful tier change', async () => {
    setupHappyPathMocks();

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    await POST(req);

    // Check that the audit log INSERT was called.
    // postgres tagged template literal: call[0] is an array of SQL fragments.
    // We check if any SQL fragment contains 'account_audit_log'.
    const auditLogCall = mockSql.mock.calls.find(
      (call: any[]) => Array.isArray(call[0]) && call[0].some((frag: string) => frag.includes('account_audit_log')),
    );
    expect(auditLogCall).toBeDefined();
  });

  it('persists the new tier base_price_cents and locations_overage_price_cents in the same transaction', async () => {
    // Regression: the route updates subscription_tier synchronously, so the
    // Stripe webhook later sees tierChanged=false and skips its CASE-WHEN
    // re-snapshot. The route must therefore write ALL tier-derived billing
    // columns itself, or a Standard->Premium change leaves the account on
    // Premium with the Standard base price / overage price (drifts billing
    // snapshot, margin reporting, and invoice reconciliation).
    setupHappyPathMocks();

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // Find the `UPDATE accounts SET ...` statement (distinct from the initial
    // SELECT, the FOR UPDATE lock, and the audit INSERT).
    const updateCall = mockSql.mock.calls.find(
      (call: any[]) =>
        Array.isArray(call[0]) &&
        call[0].some((frag: string) => frag.includes('UPDATE')) &&
        call[0].some((frag: string) => frag.includes('subscription_tier')) &&
        call[0].some((frag: string) => frag.includes('accounts')),
    );
    expect(updateCall).toBeDefined();

    const fragments = (updateCall![0] as string[]).join(' ');
    expect(fragments).toContain('base_price_cents');
    expect(fragments).toContain('locations_overage_price_cents');

    // Premium tier billing params bound into the UPDATE: base 19900, overage 2000.
    const boundValues = updateCall!.slice(1);
    expect(boundValues).toContain(19900); // TIER_CONFIG.premium.baseCents
    expect(boundValues).toContain(2000); // TIER_CONFIG.premium.overageCents
  });

  it('returns 502 when Stripe API fails', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: { basePriceCents: 19900, overagePriceCents: 0, overageUnits: 0, totalCents: 19900 },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: SUBSCRIPTION_ID,
      subscription_tier: 'standard',
    }]);
    mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
    mockSubscriptionsRetrieve.mockRejectedValueOnce(new Error('Stripe timeout'));

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'premium' });
    const res = await POST(req);
    expect(res.status).toBe(502);
  });

  it('returns 500 ambiguous_overage_item and mutates nothing when the only match is a keyword descriptor', async () => {
    // A nickname like "Extra seats" keyword-matches but is LOW confidence —
    // enough to flag, never enough to delete or re-price. Must fail closed
    // BEFORE the base mutation.
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: {
        basePriceCents: 7900,
        overagePriceCents: 2500,
        overageUnits: 2,
        totalCents: 12900,
      },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: SUBSCRIPTION_ID,
      subscription_tier: 'premium',
    }]);
    mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
    mockSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: BASE_ITEM_ID, quantity: 1, price: { id: 'price_premium_test' } },
          { id: 'si_addon', quantity: 1, price: { id: 'price_addon', nickname: 'Extra seats', unit_amount: 9900, metadata: {} } },
        ],
      },
    });

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'standard' });
    const res = await POST(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('ambiguous_overage_item');
    expect(mockSubscriptionItemsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionItemsDel).not.toHaveBeenCalled();
  });

  it('stamps metadata.billing_role=overage on overage update and create (exact matching after price rotation)', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockValidateTierChange.mockResolvedValueOnce({
      allowed: true,
      newBillingPreview: {
        basePriceCents: 7900,
        overagePriceCents: 2500,
        overageUnits: 2,
        totalCents: 12900,
      },
    });
    mockSql.mockResolvedValueOnce([{
      stripe_subscription_id: SUBSCRIPTION_ID,
      subscription_tier: 'premium',
    }]);
    mockGetAccountOwnerUserId.mockResolvedValueOnce(USER_ID);
    mockSubscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          { id: BASE_ITEM_ID, quantity: 1, price: { id: 'price_premium_test' } },
          { id: OVERAGE_ITEM_ID, quantity: 1, price: { id: 'price_premium_overage_test' } },
        ],
      },
    });
    mockSubscriptionItemsUpdate.mockResolvedValue({});

    const req = mkRequest({ accountId: ACCOUNT_ID, newTier: 'standard' });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockSubscriptionItemsUpdate).toHaveBeenCalledWith(
      OVERAGE_ITEM_ID,
      expect.objectContaining({ metadata: { billing_role: 'overage' } }),
      expect.any(Object),
    );
  });
});
