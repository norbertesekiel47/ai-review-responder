import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SubscriptionTier } from '@/lib/accounts/tier-config';
import {
  SubscriptionStatus,
  type SubscriptionStatusValue,
} from '@/lib/shared/subscription-status';

const {
  mockRequireRole,
  mockGetOffboardingState,
  mockSql,
  mockApplyTierSnapshot,
  mockCreateCheckoutSession,
  mockReleaseCouponFaultedAttempt,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetOffboardingState: vi.fn(),
  mockSql: vi.fn(),
  mockApplyTierSnapshot: vi.fn(),
  mockCreateCheckoutSession: vi.fn(),
  mockReleaseCouponFaultedAttempt: vi.fn(),
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
vi.mock('@/lib/payments/plan-activation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/plan-activation')>()),
  applyTierSnapshot: mockApplyTierSnapshot,
  releaseCouponFaultedAttempt: mockReleaseCouponFaultedAttempt,
}));
vi.mock('@/lib/payments/create-checkout-session', () => {
  class CheckoutUnavailableError extends Error {}
  class CheckoutOffboardingBlockedError extends Error {}
  // Mirrors the real 2-arg constructor + message formatting. A mock that drops
  // the class entirely makes `err instanceof undefined` throw a TypeError from
  // the route's catch, which reads as an unrelated 500 — the same trap D-16's
  // fix hit in the select-plan suite.
  class CheckoutCouponConfigurationError extends Error {
    constructor(couponId: string, cause: string) {
      super(
        `Stripe rejected the beta comp coupon "${couponId}" for this Checkout Session ` +
          `(${cause}). Verify BETA_COMP_COUPON_ID names a live, unexpired coupon in ` +
          `THIS Stripe mode, or unset it to sell at full price.`,
      );
      this.name = 'CheckoutCouponConfigurationError';
    }
  }
  return {
    CheckoutCouponConfigurationError,
    CheckoutOffboardingBlockedError,
    CheckoutUnavailableError,
    createCheckoutSession: mockCreateCheckoutSession,
  };
});

import { POST } from '../route';
import { TierNotPurchasableError } from '@/lib/payments/tier-purchasability';
import {
  CheckoutCouponConfigurationError,
  CheckoutOffboardingBlockedError,
  CheckoutUnavailableError,
} from '@/lib/payments/create-checkout-session';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ATTEMPT_ID = '11111111-2222-4333-8444-555555555555';
const APP_URL = 'http://localhost:3000';

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`${APP_URL}/api/billing/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

function account(
  status: SubscriptionStatusValue = SubscriptionStatus.PENDING_PAYMENT,
  onboardedBy: string | null = null,
) {
  return {
    id: ACCOUNT_ID,
    subscription_status: status,
    owner_email: 'owner@example.com',
    onboarded_by: onboardedBy,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue({
    id: 'user-1',
    role: 'owner',
    accountId: ACCOUNT_ID,
  });
  mockSql.mockResolvedValue([account()]);
  mockGetOffboardingState.mockResolvedValue(null);
  mockApplyTierSnapshot.mockResolvedValue({
    kind: 'ok',
    accountId: ACCOUNT_ID,
    variant: 'founding',
    attemptId: ATTEMPT_ID,
  });
  mockCreateCheckoutSession.mockResolvedValue({
    url: 'https://checkout.stripe.test/session',
    sessionId: 'cs_test_123',
  });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  process.env.TRIAL_ENABLED = 'false';
  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
});

describe('POST /api/billing/checkout', () => {
  it('rejects an invalid account UUID before account lookup or persistence', async () => {
    const res = await POST(
      request({ accountId: 'not-a-uuid', tier: SubscriptionTier.COPILOT }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store, private');
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('requires an explicit tier and creates no snapshot or Session when absent', async () => {
    const res = await POST(request({ accountId: ACCOUNT_ID }));
    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects unknown tiers before persistence', async () => {
    const res = await POST(request({ accountId: ACCOUNT_ID, tier: 'enterprise' }));
    expect(res.status).toBe(400);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  for (const tier of [SubscriptionTier.COPILOT, SubscriptionTier.AUTOPILOT] as const) {
    it(`persists explicit ${tier} before creating its variant-aware Session`, async () => {
      const res = await POST(request({ accountId: ACCOUNT_ID, tier }));
      expect(res.status).toBe(200);
      expect(mockApplyTierSnapshot).toHaveBeenCalledWith(mockSql, {
        accountId: ACCOUNT_ID,
        activationLockId: ACCOUNT_ID,
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
          activationLockId: ACCOUNT_ID,
        },
      );
      expect(mockApplyTierSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
        mockCreateCheckoutSession.mock.invocationCallOrder[0]!,
      );
    });
  }

  it('returns tier_unavailable and creates no Session when the authoritative gate rejects', async () => {
    mockApplyTierSnapshot.mockRejectedValueOnce(new TierNotPurchasableError());
    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.AUTOPILOT }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'tier_unavailable' });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('passes trial=true only for a pending self-serve explicit selection', async () => {
    process.env.TRIAL_ENABLED = 'true';
    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(res.status).toBe(200);
    expect(mockApplyTierSnapshot).toHaveBeenCalledWith(
      mockSql,
      {
        accountId: ACCOUNT_ID,
        activationLockId: ACCOUNT_ID,
        tier: SubscriptionTier.COPILOT,
        ownerEmail: 'owner@example.com',
        trial: true,
      },
    );
  });

  it('admin-provisioned pending accounts receive paid Checkout, not a trial', async () => {
    process.env.TRIAL_ENABLED = 'true';
    mockSql.mockResolvedValueOnce([account(SubscriptionStatus.PENDING_PAYMENT, 'admin-1')]);
    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(res.status).toBe(200);
    expect(mockApplyTierSnapshot.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT_ID,
      activationLockId: ACCOUNT_ID,
      tier: SubscriptionTier.COPILOT,
      ownerEmail: 'owner@example.com',
      trial: false,
    });
  });

  it('rejects an already-entitled account before snapshot or Session creation', async () => {
    mockSql.mockResolvedValueOnce([account(SubscriptionStatus.TRIALING)]);
    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(res.status).toBe(409);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('blocks offboarding accounts before snapshot or Session creation', async () => {
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
    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(res.status).toBe(403);
    expect(mockApplyTierSnapshot).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('maps missing Price configuration to a private no-store 502 response', async () => {
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutUnavailableError('missing selected Price'),
    );
    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store, private');
    expect(await res.json()).toEqual({
      error: 'checkout_unavailable',
      detail: 'missing selected Price',
    });
  });

  it('maps a beta comp coupon fault to checkout_coupon_misconfigured, not stripe_error', async () => {
    // The SECOND createCheckoutSession consumer. select-plan mapped this class
    // and this route did not, so a coupon fault here reached the owner as
    // "Unable to connect to payment provider. Please try again later." — wrong
    // in both halves — and filed Sentry under `reason: 'stripe_error'`, which is
    // exactly what made D-16's staging failure opaque.
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutCouponConfigurationError('beta_comp_3mo', 'No such coupon'),
    );

    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('checkout_coupon_misconfigured');
    expect(body.detail).toContain('beta_comp_3mo');
  });

  it('releases the coupon-faulted checkout attempt so a retry is not permanently bricked', async () => {
    // applyTierSnapshot has already COMMITTED the bad coupon into a `creating`
    // attempt, and prepareCheckoutAttempt REUSES a `creating` attempt for the
    // same selection. Without this release every retry rebuilds the identical
    // rejected params and 502s forever — and unsetting BETA_COMP_COUPON_ID
    // cannot rescue the owner, because their next attempt is not a new attempt.
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutCouponConfigurationError('beta_comp_3mo', 'No such coupon'),
    );

    await POST(request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }));

    expect(mockReleaseCouponFaultedAttempt).toHaveBeenCalledWith(
      mockSql,
      ACCOUNT_ID,
      ATTEMPT_ID,
    );
  });

  it('does NOT release the attempt on a non-coupon checkout failure', async () => {
    // A provider outage leaves a legitimately reusable lease. Clearing it there
    // would discard a valid attempt and re-mint one on every transient Stripe
    // blip, which is the opposite of what the idempotency key exists for.
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutUnavailableError('missing selected Price'),
    );

    await POST(request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }));

    expect(mockReleaseCouponFaultedAttempt).not.toHaveBeenCalled();
  });

  it('maps offboarding that starts after freeze to a private blocked response', async () => {
    mockCreateCheckoutSession.mockRejectedValueOnce(
      new CheckoutOffboardingBlockedError(),
    );

    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store, private');
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
  });

  it('maps provider errors to a private no-store 502 response', async () => {
    mockCreateCheckoutSession.mockRejectedValueOnce(new Error('Stripe unavailable'));
    const res = await POST(
      request({ accountId: ACCOUNT_ID, tier: SubscriptionTier.COPILOT }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get('cache-control')).toBe('no-store, private');
    expect((await res.json()).error).toBe('stripe_error');
  });
});
