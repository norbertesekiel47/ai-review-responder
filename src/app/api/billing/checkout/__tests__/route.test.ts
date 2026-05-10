// src/app/api/billing/checkout/__tests__/route.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

const { mockRequireRole } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
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

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  mockSql.mockResolvedValue([accountRow(SubscriptionStatus.PENDING_PAYMENT)]);
  mockCreateCheckoutSession.mockResolvedValue({
    url: 'https://checkout.stripe.test/session',
    sessionId: 'cs_test_123',
  });
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
    );
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
});
