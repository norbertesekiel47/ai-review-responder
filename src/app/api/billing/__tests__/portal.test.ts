// src/app/api/billing/__tests__/portal.test.ts
//
// TDD assertions for POST /api/billing/portal.
// Validation contract: VAL-BILLING-068, VAL-BILLING-069.
// Security: requires owner auth; loads Stripe customer from session only.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const {
  mockRequireRole,
  mockSql,
  mockPortalCreate,
  mockConfigList,
  mockConfigCreate,
  mockGetOffboardingState,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSql: vi.fn(),
  mockPortalCreate: vi.fn(),
  mockConfigList: vi.fn(),
  mockConfigCreate: vi.fn(),
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
      billingPortal = {
        sessions: { create: mockPortalCreate },
        configurations: {
          list: mockConfigList,
          create: mockConfigCreate,
        },
      };
      checkout = {
        sessions: { create: vi.fn() },
      };
    },
  };
});

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';

import { POST, resetPortalConfigurationCacheForTests } from '../portal/route';
import { AuthError } from '@/lib/db/auth';

// ── Helpers ────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ACCOUNT_ID = '99999999-8888-7777-6666-555555555555';
const USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';
const APP_URL = 'http://localhost:3000';

function mkRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/billing/portal', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: APP_URL },
    body: body ? JSON.stringify(body) : undefined,
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

function mockAccountRow(status: string, stripeCustomerId: string | null) {
  return {
    id: ACCOUNT_ID,
    subscription_status: status,
    stripe_customer_id: stripeCustomerId,
  };
}

function safePortalConfiguration(id: string) {
  return {
    id,
    active: true,
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: false },
    },
  };
}

function unsafeCancellationPortalConfiguration(id: string) {
  return {
    id,
    active: true,
    features: {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // The route memoizes the portal configuration ID per process; reset so each
  // test observes its own configurations.list/create traffic.
  resetPortalConfigurationCacheForTests();
  mockRequireRole.mockReset();
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockGetOffboardingState.mockReset();
  mockGetOffboardingState.mockResolvedValue(null);
  mockPortalCreate.mockReset();
  mockConfigList.mockReset();
  mockConfigCreate.mockReset();

  // Default: existing active portal configuration
  mockConfigList.mockResolvedValue({
    data: [safePortalConfiguration('bpc_test_existing')],
  });

  // Default: successful portal session creation
  mockPortalCreate.mockResolvedValue({
    id: 'bps_test_1',
    url: 'https://billing.stripe.com/p/test/portal',
  });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/billing/portal', () => {
  // ── Auth & ownership ────────────────────────────────────────────────────

  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Unauthorized', 401));

    const req = mkRequest();
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('returns 403 when non-owner role', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const req = mkRequest();
    const res = await POST(req);
    expect(res.status).toBe(403);
  });

  it('returns 403 when user has no accountId', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser({ accountId: null }));

    const req = mkRequest();
    const res = await POST(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('No account associated with this user');
  });

  it('ignores body.accountId and uses session accountId (prevents cross-account access)', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);

    // Request with a DIFFERENT accountId in the body — should be ignored
    const req = mkRequest({ accountId: OTHER_ACCOUNT_ID });
    const res = await POST(req);

    expect(res.status).toBe(200);
    // The SQL lookup should use the session accountId, not the body.
    // postgres tagged template literal: call[0] is the strings array,
    // call[1+] are the interpolated values. We check that ACCOUNT_ID
    // appears in the values (not OTHER_ACCOUNT_ID).
    const sqlValues = mockSql.mock.calls.flat().filter(
      (v: unknown) => v === ACCOUNT_ID || v === OTHER_ACCOUNT_ID,
    );
    expect(sqlValues).toContain(ACCOUNT_ID);
    expect(sqlValues).not.toContain(OTHER_ACCOUNT_ID);
  });

  // ── Business logic ─────────────────────────────────────────────────────

  // VAL-BILLING-068: Portal session created with configuration for both subscription items
  it('creates portal session with existing configuration', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);

    const req = mkRequest();
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe('https://billing.stripe.com/p/test/portal');

    // Verify portal session creation was called with correct args
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test_123',
        return_url: expect.stringContaining('/settings/billing'),
      }),
    );
    // Verify it used the existing configuration
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: 'bpc_test_existing',
      }),
    );
  });

  it('allows portal management during cancel-only scheduled offboarding', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);
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

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockPortalCreate).toHaveBeenCalled();
  });

  it('blocks portal management during delete-data offboarding', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);
    mockGetOffboardingState.mockResolvedValueOnce({
      id: 'offboarding-1',
      accountId: ACCOUNT_ID,
      mode: 'delete_data',
      status: 'pending',
      failedStep: null,
      terminalAt: null,
      accessEndsAt: null,
      teardownStartedAt: null,
      purgeAfter: null,
      purgeStartedAt: null,
      purgeCancelledAt: null,
    });

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockPortalCreate).not.toHaveBeenCalled();
  });

  it('does not use an existing portal configuration that enables subscription cancellation', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);
    mockConfigList.mockResolvedValueOnce({
      data: [
        unsafeCancellationPortalConfiguration('bpc_cancel_enabled'),
        safePortalConfiguration('bpc_cancel_disabled'),
      ],
    });

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockConfigCreate).not.toHaveBeenCalled();
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: 'bpc_cancel_disabled',
      }),
    );
  });

  it('creates default portal configuration without self-serve subscription cancellation when none exists', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);
    mockConfigList.mockResolvedValueOnce({ data: [] });
    mockConfigCreate.mockResolvedValueOnce({ id: 'bpc_test_new' });

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockConfigCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({
          payment_method_update: { enabled: true },
          invoice_history: { enabled: true },
          subscription_cancel: expect.objectContaining({
            enabled: false,
          }),
        }),
      }),
    );
    expect(mockConfigCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({
          subscription_cancel: expect.objectContaining({ enabled: true }),
        }),
      }),
    );
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: 'bpc_test_new',
      }),
    );
  });

  // VAL-BILLING-069: Portal session creation failure returns error
  it('returns 502 when Stripe portal session creation fails', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);
    mockPortalCreate.mockRejectedValueOnce(new Error('Stripe API timeout'));

    const req = mkRequest();
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('portal_unavailable');
    expect(body.detail).toContain('try again');
  });

  it('returns 404 when account not found', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([]); // no account found

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it('returns 409 when subscription is pending_payment', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('pending_payment', 'cus_test_123')]);

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(409);
  });

  it('returns 400 when account has no Stripe customer ID', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('active', null)]);

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('allows portal for past_due accounts (need to update card)', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('past_due', 'cus_test_123')]);

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  it('allows portal for cancelled accounts (view invoices)', async () => {
    mockRequireRole.mockResolvedValueOnce(ownerUser());
    mockSql.mockResolvedValueOnce([mockAccountRow('cancelled', 'cus_test_123')]);

    const req = mkRequest();
    const res = await POST(req);

    expect(res.status).toBe(200);
  });
});
