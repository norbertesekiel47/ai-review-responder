import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SubscriptionTier } from '@/lib/accounts/tier-config';

const {
  mockCheckRateLimit,
  mockCreateServerClient,
  mockGetUser,
  mockCreateCheckoutSession,
  mockApplyTierSnapshot,
  mockResolveCheckoutContext,
  mockReleaseCouponFaultedAttempt,
  mockSql,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockCreateServerClient: vi.fn(),
  mockGetUser: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockApplyTierSnapshot: vi.fn(),
  mockResolveCheckoutContext: vi.fn(),
  mockReleaseCouponFaultedAttempt: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mockCreateServerClient }));
vi.mock('@/lib/payments/plan-activation', () => {
  class CheckoutAttemptConflictError extends Error {}
  return {
    CheckoutAttemptConflictError,
    applyTierSnapshot: mockApplyTierSnapshot,
    resolveCheckoutContext: mockResolveCheckoutContext,
    releaseCouponFaultedAttempt: mockReleaseCouponFaultedAttempt,
  };
});
vi.mock('@/lib/payments/create-checkout-session', () => {
  class CheckoutUnavailableError extends Error {}
  class CheckoutOffboardingBlockedError extends Error {}
  // Mirrors the real 2-arg constructor (couponId, cause) so the message the
  // route forwards is shaped like production's.
  class CheckoutCouponConfigurationError extends Error {
    constructor(couponId: string, cause: string) {
      super(`Stripe rejected the beta comp coupon "${couponId}" (${cause})`);
    }
  }
  return {
    CheckoutCouponConfigurationError,
    CheckoutOffboardingBlockedError,
    CheckoutUnavailableError,
    createCheckoutSession: mockCreateCheckoutSession,
  };
});

process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { POST } from '../select-plan/route';
import { TierNotPurchasableError } from '@/lib/payments/tier-purchasability';
import { CheckoutUnavailableError } from '@/lib/payments/create-checkout-session';
import { CheckoutOffboardingBlockedError } from '@/lib/payments/create-checkout-session';
import { CheckoutAttemptConflictError } from '@/lib/payments/plan-activation';
import { resetServerConfigForTests } from '@/lib/config/server';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const BUSINESS_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';

function request(body: unknown, origin = 'https://app.example.com'): NextRequest {
  return new NextRequest('https://app.example.com/api/onboarding/select-plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      host: 'app.example.com',
    },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string): NextRequest {
  return new NextRequest('https://app.example.com/api/onboarding/select-plan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      host: 'app.example.com',
    },
    body,
  });
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store, private');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  resetServerConfigForTests();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-uuid-1' } } });
  mockCreateServerClient.mockReturnValue({ auth: { getUser: mockGetUser } });
  mockSql.mockResolvedValue([
    {
      id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      owner_email: 'owner@example.com',
    },
  ]);
  mockApplyTierSnapshot.mockResolvedValue({
    kind: 'ok',
    accountId: ACCOUNT_ID,
    variant: 'founding',
    attemptId: ATTEMPT_ID,
  });
  mockResolveCheckoutContext.mockResolvedValue({
    accountId: ACCOUNT_ID,
    trialEligible: false,
  });
  mockCreateCheckoutSession.mockResolvedValue({
    url: 'https://checkout.stripe.test/session',
    sessionId: 'cs_test_1',
  });
});

describe('POST /api/onboarding/select-plan', () => {
  it('creates a Session for an owner when self-serve signup is disabled', async () => {
    // The re-scoped flag gates anonymous account-minting only; an
    // admin-invited owner buys through this same route while it is off. The
    // boundary is session + `u.role = 'owner'` + the pending_payment check
    // applyTierSnapshot makes under the activation lock.
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    resetServerConfigForTests();
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      paymentUrl: 'https://checkout.stripe.test/session',
    });
    expect(mockApplyTierSnapshot).toHaveBeenCalledTimes(1);
  });

  it('select-plan rejects a non-pending_payment account', async () => {
    // The state gate that replaced the flag: applyTierSnapshot re-reads the
    // status while holding the activation lock and refuses anything but
    // pending_payment, so an already-active owner cannot double-subscribe.
    mockApplyTierSnapshot.mockResolvedValueOnce({
      kind: 'wrong_status',
      status: 'active',
    });

    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));

    expect(res.status).toBe(409);
    expectPrivateNoStore(res);
    expect(await res.json()).toEqual({
      error: 'subscription_not_pending',
      subscriptionStatus: 'active',
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('scopes the business lookup to an owner role at the SQL boundary', async () => {
    // Proxy does not gate /api/onboarding/* on role, so the filter here is the
    // authorization invariant — not a convenience.
    await POST(request({ tier: SubscriptionTier.COPILOT }));

    const callArgs = mockSql.mock.calls[0] as unknown[];
    const query = (callArgs[0] as TemplateStringsArray).join('?');
    expect(query).toContain("u.role = 'owner'");
  });

  it('returns a private no-store 400 for invalid JSON before auth', async () => {
    const res = await POST(rawRequest('{'));
    expect(res.status).toBe(400);
    expectPrivateNoStore(res);
    expect(mockCreateServerClient).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('requires an explicit tier and never creates an implicit Copilot Session', async () => {
    const res = await POST(request({}));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects unknown and legacy tiers before auth or persistence', async () => {
    for (const tier of ['enterprise', 'free']) {
      const res = await POST(request({ tier }));
      expect(res.status).toBe(400);
    }
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects cross-origin writes before auth', async () => {
    const res = await POST(
      request({ tier: SubscriptionTier.COPILOT }, 'https://attacker.example.com'),
    );
    expect(res.status).toBe(403);
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('returns 401 without an owner session', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(401);
    expectPrivateNoStore(res);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
  });

  it('returns 429 on an authenticated-owner rate-limit denial without state changes', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(429);
    expectPrivateNoStore(res);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('returns 429 on an IP rate-limit denial without state changes', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 9 })
      .mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(429);
    expectPrivateNoStore(res);
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('strict rate-limit failure creates no state or Session', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('redis down'));
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(503);
    expectPrivateNoStore(res);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('owner lookup remains tenant/role scoped', async () => {
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(200);
    const text = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(text).toMatch(/u\.auth_id\s*=\s*\?/);
    expect(text).toMatch(/u\.role\s*=\s*'owner'/);
    expect(text).toMatch(/a\.id\s+AS\s+account_id/i);
  });

  it('returns 404 without an attached account and creates no Session', async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(404);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  for (const tier of [SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT] as const) {
    it(`persists explicit ${tier} before creating its founding Session`, async () => {
      const res = await POST(request({ tier }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        paymentUrl: 'https://checkout.stripe.test/session',
      });
      expect(mockApplyTierSnapshot).toHaveBeenCalledWith(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: BUSINESS_ID,
        tier,
        ownerEmail: 'owner@example.com',
        trial: false,
      });
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        mockSql,
        ACCOUNT_ID,
        tier,
        'founding',
        {
          attemptId: ATTEMPT_ID,
          activationLockId: BUSINESS_ID,
        },
      );
      expect(mockApplyTierSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateCheckoutSession.mock.invocationCallOrder[0]!,
      );
    });
  }

  it('returns wrong-status conflict without creating a Session', async () => {
    mockApplyTierSnapshot.mockResolvedValueOnce({
      kind: 'wrong_status',
      status: 'active',
    });
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(409);
    expectPrivateNoStore(res);
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('returns an offboarding conflict without creating a Session', async () => {
    mockApplyTierSnapshot.mockResolvedValueOnce({ kind: 'offboarding_blocked' });

    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));

    expect(res.status).toBe(403);
    expectPrivateNoStore(res);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('closed Autopilot gate creates no Session', async () => {
    mockApplyTierSnapshot.mockRejectedValueOnce(new TierNotPurchasableError());
    const res = await POST(request({ tier: SubscriptionTier.AUTOPILOT }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'tier_unavailable' });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it.each([
    'prior Session completed',
    'different attempt still creating',
    'prior Session expiry failed',
  ])('maps %s selection conflict to 409 and creates no new Session', async (reason) => {
    mockApplyTierSnapshot.mockRejectedValueOnce(
      new CheckoutAttemptConflictError(reason),
    );

    const res = await POST(request({ tier: SubscriptionTier.AUTOPILOT }));

    expect(res.status).toBe(409);
    expectPrivateNoStore(res);
    expect(await res.json()).toEqual({ error: 'checkout_attempt_conflict' });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('passes server-authoritative trial eligibility for the explicit tier', async () => {
    mockResolveCheckoutContext.mockResolvedValueOnce({
      accountId: ACCOUNT_ID,
      trialEligible: true,
    });
    const res = await POST(request({ tier: SubscriptionTier.AUTOPILOT }));
    expect(res.status).toBe(200);
    expect(mockApplyTierSnapshot.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
      ownerEmail: 'owner@example.com',
      trial: true,
    });
  });

  it('excludes admin-provisioned accounts from the trial', async () => {
    mockResolveCheckoutContext.mockResolvedValueOnce({
      accountId: ACCOUNT_ID,
      trialEligible: false,
    });
    const res = await POST(request({ tier: SubscriptionTier.AUTOPILOT }));
    expect(res.status).toBe(200);
    expectPrivateNoStore(res);
    expect(mockApplyTierSnapshot.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT_ID,
      activationLockId: BUSINESS_ID,
      tier: SubscriptionTier.AUTOPILOT,
      ownerEmail: 'owner@example.com',
      trial: false,
    });
  });

  it('maps missing Price configuration to a private no-store checkout_unavailable response', async () => {
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutUnavailableError('missing base Price'),
    );
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(502);
    expectPrivateNoStore(res);
    expect(await res.json()).toEqual({
      error: 'checkout_unavailable',
      detail: 'missing base Price',
    });
  });

  it('maps offboarding that starts after freeze to a private blocked response', async () => {
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutOffboardingBlockedError(),
    );

    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));

    expect(res.status).toBe(403);
    expectPrivateNoStore(res);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
  });

  it('maps provider failures to a private no-store checkout_error response', async () => {
    mockCreateCheckoutSession.mockRejectedValueOnce(new Error('provider unavailable'));
    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));
    expect(res.status).toBe(502);
    expectPrivateNoStore(res);
    expect(await res.json()).toEqual({
      error: 'checkout_error',
      detail: 'Unable to connect to payment provider. Please try again later.',
    });
  });

  it('maps a Beta comp coupon misconfiguration to its own error, not checkout_error', async () => {
    // Regression guard for the first staging checkout failure. A coupon fault
    // is a CONFIGURATION problem: it fails every Admin invite identically and
    // retrying cannot help. Collapsed into `checkout_error` it told the owner
    // "Unable to connect to payment provider. Please try again later." — wrong
    // in both halves, and it cost a staging debugging round to see past.
    const { CheckoutCouponConfigurationError } = await import(
      '@/lib/payments/create-checkout-session'
    );
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutCouponConfigurationError('beta_comp_3mo', 'No such coupon'),
    );

    const res = await POST(request({ tier: SubscriptionTier.COPILOT }));

    expect(res.status).toBe(502);
    expectPrivateNoStore(res);
    const body = await res.json();
    expect(body.error).toBe('checkout_coupon_misconfigured');
    expect(body.detail).toContain('beta_comp_3mo');
  });

  it('releases the coupon-faulted attempt so the owner is not permanently bricked', async () => {
    // applyTierSnapshot has already COMMITTED the bad coupon into a `creating`
    // attempt, and prepareCheckoutAttempt REUSES a `creating` attempt for the
    // same selection. Without the release every retry rebuilds the identical
    // rejected Stripe params and 502s forever — and unsetting BETA_COMP_COUPON_ID
    // cannot rescue this owner, because their next attempt is not a new attempt.
    // Step-7 spec review, and the half of the rollback plan that was untrue.
    const { CheckoutCouponConfigurationError } = await import(
      '@/lib/payments/create-checkout-session'
    );
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutCouponConfigurationError('beta_comp_3mo', 'No such coupon'),
    );

    await POST(request({ tier: SubscriptionTier.COPILOT }));

    expect(mockReleaseCouponFaultedAttempt).toHaveBeenCalledOnce();
  });

  it('does NOT release the attempt on a non-coupon checkout failure', async () => {
    // A provider outage leaves a legitimately reusable lease. Clearing it there
    // would discard a valid attempt and re-mint one on every transient Stripe
    // blip — the opposite of what the per-attempt idempotency key exists for.
    const { CheckoutUnavailableError } = await import(
      '@/lib/payments/create-checkout-session'
    );
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutUnavailableError('missing selected Price'),
    );

    await POST(request({ tier: SubscriptionTier.COPILOT }));

    expect(mockReleaseCouponFaultedAttempt).not.toHaveBeenCalled();
  });
});
