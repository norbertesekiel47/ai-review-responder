// src/app/api/billing/checkout/__tests__/route.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

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

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('@/lib/account-offboarding/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-offboarding/gate')>();
  return {
    ...actual,
    getOffboardingState: (...args: unknown[]) => mockGetOffboardingState(...args),
  };
});

const { mockCreateCheckoutSession } = vi.hoisted(() => ({
  mockCreateCheckoutSession: vi.fn(),
}));

vi.mock('@/lib/payments/create-checkout-session', () => {
  class CheckoutUnavailableError extends Error {}
  return {
    createCheckoutSession: mockCreateCheckoutSession,
    CheckoutUnavailableError,
  };
});

import { POST } from '../route';

const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';
const APP_URL = 'http://localhost:3000';

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: APP_URL },
    body: JSON.stringify(body),
  });
}

function ownerUser() {
  return {
    id: USER_ID,
    name: 'Test Owner',
    email: 'owner@test.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
  };
}

function accountRow(status: string) {
  return {
    id: ACCOUNT_ID,
    subscription_tier: 'standard',
    subscription_status: status,
    owner_email: 'owner@test.com',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireRole.mockResolvedValue(ownerUser());
  mockGetOffboardingState.mockResolvedValue(null);
  mockSql.mockResolvedValue([accountRow(SubscriptionStatus.PENDING_PAYMENT)]);
  mockCreateCheckoutSession.mockResolvedValue({
    url: 'https://checkout.stripe.test/session',
    sessionId: 'cs_test_123',
  });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
});

describe('POST /api/billing/checkout', () => {
  it('creates a checkout session for pending_payment accounts', async () => {
    const res = await POST(mkRequest({ accountId: ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      url: 'https://checkout.stripe.test/session',
      sessionId: 'cs_test_123',
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'standard',
      'owner@test.com',
      { trial: false },
    );
  });

  it('passes trial:true to createCheckoutSession when TRIAL_ENABLED=true', async () => {
    const prev = process.env.TRIAL_ENABLED;
    process.env.TRIAL_ENABLED = 'true';
    try {
      const res = await POST(mkRequest({ accountId: ACCOUNT_ID }));
      expect(res.status).toBe(200);
      expect(mockCreateCheckoutSession).toHaveBeenCalledWith(
        ACCOUNT_ID,
        'standard',
        'owner@test.com',
        { trial: true },
      );
    } finally {
      if (prev === undefined) delete process.env.TRIAL_ENABLED;
      else process.env.TRIAL_ENABLED = prev;
    }
  });

  it('rejects past_due accounts without creating a duplicate checkout subscription', async () => {
    mockSql.mockResolvedValueOnce([accountRow(SubscriptionStatus.PAST_DUE)]);

    const res = await POST(mkRequest({ accountId: ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: 'account_already_active',
      subscriptionStatus: SubscriptionStatus.PAST_DUE,
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects trialing accounts without creating a duplicate subscription', async () => {
    mockSql.mockResolvedValueOnce([accountRow(SubscriptionStatus.TRIALING)]);

    const res = await POST(mkRequest({ accountId: ACCOUNT_ID }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: 'account_already_active',
      subscriptionStatus: SubscriptionStatus.TRIALING,
    });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it('blocks checkout when account offboarding forbids billing expansion', async () => {
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

    const res = await POST(mkRequest({ accountId: ACCOUNT_ID }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });
});
