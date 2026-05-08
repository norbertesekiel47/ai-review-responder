// src/app/api/billing/__tests__/portal.test.ts
//
// TDD assertions for POST /api/billing/portal.
// Validation contract: VAL-BILLING-068, VAL-BILLING-069.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSql, mockPortalCreate, mockConfigList, mockConfigCreate } = vi.hoisted(() => ({
  mockSql: vi.fn(),
  mockPortalCreate: vi.fn(),
  mockConfigList: vi.fn(),
  mockConfigCreate: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

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

import { POST } from '../portal/route';

// ── Helpers ────────────────────────────────────────────────────────────────

function mkRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/billing/portal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockAccountRow(status: string, stripeCustomerId: string | null) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    subscription_status: status,
    stripe_customer_id: stripeCustomerId,
  };
}

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockPortalCreate.mockReset();
  mockConfigList.mockReset();
  mockConfigCreate.mockReset();

  // Default: existing active portal configuration
  mockConfigList.mockResolvedValue({
    data: [{ id: 'bpc_test_existing', active: true }],
  });

  // Default: successful portal session creation
  mockPortalCreate.mockResolvedValue({
    id: 'bps_test_1',
    url: 'https://billing.stripe.com/p/test/portal',
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /api/billing/portal', () => {
  // VAL-BILLING-068: Portal session created with configuration for both subscription items
  it('creates portal session with existing configuration', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);

    const req = mkRequest({ accountId });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe('https://billing.stripe.com/p/test/portal');

    // Verify portal session creation was called with correct args
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_test_123',
        return_url: expect.stringContaining('/settings'),
      }),
    );
    // Verify it used the existing configuration
    expect(mockPortalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: 'bpc_test_existing',
      }),
    );
  });

  it('creates default portal configuration when none exists', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);
    mockConfigList.mockResolvedValueOnce({ data: [] });
    mockConfigCreate.mockResolvedValueOnce({ id: 'bpc_test_new' });

    const req = mkRequest({ accountId });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(mockConfigCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({
          payment_method_update: { enabled: true },
          invoice_history: { enabled: true },
          subscription_cancel: expect.objectContaining({
            enabled: true,
            mode: 'at_period_end',
          }),
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
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('active', 'cus_test_123')]);
    mockPortalCreate.mockRejectedValueOnce(new Error('Stripe API timeout'));

    const req = mkRequest({ accountId });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('portal_unavailable');
    expect(body.detail).toContain('try again');
  });

  it('returns 404 when account not found', async () => {
    const accountId = '00000000-0000-7f00-8000-000000000000';
    mockSql.mockResolvedValueOnce([]); // no account found

    const req = mkRequest({ accountId });
    const res = await POST(req);

    expect(res.status).toBe(404);
  });

  it('returns 409 when subscription is pending_payment', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('pending_payment', 'cus_test_123')]);

    const req = mkRequest({ accountId });
    const res = await POST(req);

    expect(res.status).toBe(409);
  });

  it('returns 400 when account has no Stripe customer ID', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('active', null)]);

    const req = mkRequest({ accountId });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid accountId format', async () => {
    const req = mkRequest({ accountId: 'not-a-uuid' });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid JSON body', async () => {
    const req = new NextRequest('http://localhost:3000/api/billing/portal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
  });

  it('allows portal for past_due accounts (need to update card)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('past_due', 'cus_test_123')]);

    const req = mkRequest({ accountId });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });

  it('allows portal for cancelled accounts (view invoices)', async () => {
    const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockSql.mockResolvedValueOnce([mockAccountRow('cancelled', 'cus_test_123')]);

    const req = mkRequest({ accountId });
    const res = await POST(req);

    expect(res.status).toBe(200);
  });
});
