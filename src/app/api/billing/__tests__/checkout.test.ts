// Security and orchestration coverage for POST /api/billing/checkout.
// Price/quantity matrices live in create-checkout-session.test.ts; this suite
// proves the route cannot infer a tier and persists the explicit selection
// before delegating the external Checkout side effect.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

const {
  mockRequireRole,
  mockSql,
  mockGetOffboardingState,
  mockApplyTierSnapshot,
  mockCreateCheckoutSession,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSql: vi.fn(),
  mockGetOffboardingState: vi.fn(),
  mockApplyTierSnapshot: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
}));

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
vi.mock('@/lib/payments/plan-activation', () => ({
  applyTierSnapshot: mockApplyTierSnapshot,
}));
vi.mock('@/lib/payments/create-checkout-session', () => {
  class CheckoutUnavailableError extends Error {}
  return {
    CheckoutUnavailableError,
    createCheckoutSession: mockCreateCheckoutSession,
  };
});

import { POST } from '../checkout/route';
import { AuthError } from '@/lib/db/auth';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_ACCOUNT_ID = '99999999-8888-7777-6666-555555555555';
const APP_URL = 'http://localhost:3000';

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`${APP_URL}/api/billing/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

function account(
  subscriptionStatus: string = SubscriptionStatus.PENDING_PAYMENT,
  onboardedBy: string | null = null,
) {
  return {
    id: ACCOUNT_ID,
    subscription_status: subscriptionStatus,
    owner_email: 'owner@example.com',
    onboarded_by: onboardedBy,
  };
}

function explicitRequest(
  tier: 'copilot' | 'autopilot' = SubscriptionTier.COPILOT,
  accountId = ACCOUNT_ID,
): NextRequest {
  return request({ accountId, tier });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({
    id: 'owner-1',
    role: 'owner',
    accountId: ACCOUNT_ID,
  });
  mockSql.mockResolvedValue([account()]);
  mockGetOffboardingState.mockResolvedValue(null);
  mockApplyTierSnapshot.mockResolvedValue({
    kind: 'ok',
    accountId: ACCOUNT_ID,
    variant: 'founding',
  });
  mockCreateCheckoutSession.mockResolvedValue({
    url: 'https://checkout.stripe.test/session',
    sessionId: 'cs_test_123',
  });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  process.env.TRIAL_ENABLED = 'false';
  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
});

describe('POST /api/billing/checkout security and orchestration', () => {
  it('returns 401 when not authenticated', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Unauthorized', 401));
    const response = await POST(explicitRequest());
    expect(response.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not an owner', async () => {
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const response = await POST(explicitRequest());
    expect(response.status).toBe(403);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 403 when the owner has no account', async () => {
    mockRequireRole.mockResolvedValueOnce({ id: 'owner-1', role: 'owner', accountId: null });
    const response = await POST(explicitRequest());
    expect(response.status).toBe(403);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('requires an explicit tier before any account lookup or Stripe delegation', async () => {
    const response = await POST(request({ accountId: ACCOUNT_ID }));
    expect(response.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects an account-id mismatch before lookup', async () => {
    const response = await POST(explicitRequest(SubscriptionTier.COPILOT, OTHER_ACCOUNT_ID));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Account ID mismatch' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('loads owner email through users, never a removed accounts.owner_email column', async () => {
    await POST(explicitRequest());
    const query = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(query).toMatch(/FROM\s+accounts\s+a/i);
    expect(query).toMatch(/JOIN\s+users\s+u\s+ON\s+u\.id\s*=\s*a\.owner_user_id/i);
    expect(query).toMatch(/u\.email\s+AS\s+owner_email/i);
  });

  it('blocks offboarding before snapshot or Checkout creation', async () => {
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
    const response = await POST(explicitRequest());
    expect(response.status).toBe(403);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it.each([
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.TRIALING,
    SubscriptionStatus.PAST_DUE,
  ])('rejects an existing %s subscription before mutation', async (status) => {
    mockSql.mockResolvedValueOnce([account(status)]);
    const response = await POST(explicitRequest());
    expect(response.status).toBe(409);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('returns 404 when the account lookup is empty', async () => {
    mockSql.mockResolvedValueOnce([]);
    const response = await POST(explicitRequest());
    expect(response.status).toBe(404);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
  });

  it('commits explicit Autopilot/founding selection before creating its Session', async () => {
    const response = await POST(explicitRequest(SubscriptionTier.AUTOPILOT));
    expect(response.status).toBe(200);
    expect(mockApplyTierSnapshot).toHaveBeenCalledWith(mockSql, {
      accountId: ACCOUNT_ID,
      activationLockId: ACCOUNT_ID,
      tier: SubscriptionTier.AUTOPILOT,
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      mockSql,
      ACCOUNT_ID,
      SubscriptionTier.AUTOPILOT,
      'founding',
      'owner@example.com',
      { trial: false },
    );
    expect(mockApplyTierSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateCheckoutSession.mock.invocationCallOrder[0]!,
    );
  });

  it('does not create a Session when the locked snapshot sees a non-pending status', async () => {
    mockApplyTierSnapshot.mockResolvedValueOnce({ kind: 'wrong_status', status: 'cancelled' });
    const response = await POST(explicitRequest());
    expect(response.status).toBe(409);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });
});
