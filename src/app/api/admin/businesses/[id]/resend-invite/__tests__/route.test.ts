// Route suite for POST /api/admin/businesses/[id]/resend-invite (plan step 9 / T7).
//
// The route is an orchestrator (invariant #12): guards → one module call →
// status mapping. So this suite drives the REAL domain module
// (src/lib/onboarding/resend-invite.ts) through a mocked `sql` + a mocked
// Supabase admin client, and asserts what an admin actually receives on the
// wire. No network calls.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockRows,
  mockGetUserById,
  mockInviteUserByEmail,
  mockCheckRateLimit,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockRequireCurrentAal2FromSupabase: vi.fn(),
  mockRows: [] as unknown[][],
  mockGetUserById: vi.fn(),
  mockInviteUserByEmail: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
    AuthError,
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

vi.mock('@/lib/db/server', () => ({
  sql: (..._args: unknown[]) => Promise.resolve(mockRows.shift() ?? []),
  supabaseServer: {
    auth: {
      admin: {
        getUserById: mockGetUserById,
        inviteUserByEmail: mockInviteUserByEmail,
      },
    },
  },
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

// Import AFTER mocks
import { POST } from '../route';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

const APP_URL = 'http://localhost';
const BUSINESS_ID = '00000000-0000-0000-0000-0000000000b1';
const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000a1';
const OWNER_AUTH_ID = '00000000-0000-0000-0000-0000000000d1';
const OWNER_EMAIL = 'alice@example.com';

process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/businesses/${BUSINESS_ID}/resend-invite`,
    { method: 'POST', headers: { Origin: APP_URL } },
  );
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

function seedOwnerRow(overrides: Record<string, unknown> = {}): void {
  mockRows.push([
    {
      business_id: BUSINESS_ID,
      account_id: ACCOUNT_ID,
      subscription_status: SubscriptionStatus.PENDING_PAYMENT,
      owner_user_id: '00000000-0000-0000-0000-0000000000c1',
      owner_email: OWNER_EMAIL,
      owner_auth_id: OWNER_AUTH_ID,
      ...overrides,
    },
  ]);
}

beforeEach(() => {
  mockRequireRole.mockReset().mockResolvedValue({ role: 'admin', id: 'admin-1' });
  mockRequireCurrentAal2FromSupabase.mockReset().mockResolvedValue({ ok: true });
  mockRows.length = 0;
  mockGetUserById.mockReset().mockResolvedValue({
    data: { user: { id: OWNER_AUTH_ID, email: OWNER_EMAIL, last_sign_in_at: null } },
    error: null,
  });
  mockInviteUserByEmail.mockReset().mockResolvedValue({
    data: { user: { id: OWNER_AUTH_ID, email: OWNER_EMAIL } },
    error: null,
  });
  mockCheckRateLimit.mockReset().mockResolvedValue({ allowed: true, remaining: 2 });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /api/admin/businesses/[id]/resend-invite', () => {
  it('resend-invite requires admin AAL2', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({
      ok: false,
      reason: 'mfa_required',
    });
    seedOwnerRow();

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));

    expect(res.status).toBe(403);
    // Auth before spend: no rate-limit budget, no provider round-trip.
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });

  it('rejects a non-admin caller before any provider work', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValueOnce(
      new (AuthError as unknown as new (m: string, s: number) => Error)('forbidden', 403),
    );

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));

    expect(res.status).toBe(403);
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin POST', async () => {
    const res = await POST(
      new NextRequest(
        `http://localhost/api/admin/businesses/${BUSINESS_ID}/resend-invite`,
        { method: 'POST', headers: { Origin: 'https://evil.example.com' } },
      ),
      paramsFor(BUSINESS_ID),
    );

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });

  it('resend-invite resends for an owner who has never signed in', async () => {
    seedOwnerRow();

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));
    const body = (await res.json()) as { success?: boolean; ownerEmailRedacted?: string };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The response carries the redacted address only — never the raw owner email.
    expect(body.ownerEmailRedacted).toBe('a***@example.com');
    expect(mockInviteUserByEmail).toHaveBeenCalledTimes(1);
    expect(mockInviteUserByEmail).toHaveBeenCalledWith(OWNER_EMAIL, {
      redirectTo: `${APP_URL}/api/auth/callback?flow=owner&next=/reset-password`,
    });
  });

  it('resend-invite rejects an owner who has already signed in', async () => {
    seedOwnerRow();
    mockGetUserById.mockResolvedValueOnce({
      data: {
        user: {
          id: OWNER_AUTH_ID,
          email: OWNER_EMAIL,
          last_sign_in_at: '2026-08-13T09:00:00.000Z',
        },
      },
      error: null,
    });

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(409);
    expect(body.code).toBe('OWNER_ALREADY_SIGNED_IN');
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });

  it('resend-invite maps an unknown provider error to 502', async () => {
    seedOwnerRow();
    mockInviteUserByEmail.mockResolvedValueOnce({
      data: { user: null },
      error: { code: 'some_future_code', status: 400, message: 'nope' },
    });

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(502);
    expect(body.code).toBe('INVITE_FAILED_UNKNOWN');
    // No retry: exactly one provider call for the whole request.
    expect(mockInviteUserByEmail).toHaveBeenCalledTimes(1);
  });

  it('maps a provider rate-limit error to 429', async () => {
    seedOwnerRow();
    mockInviteUserByEmail.mockResolvedValueOnce({
      data: { user: null },
      error: { code: 'over_email_send_rate_limit', status: 429, message: 'slow down' },
    });

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));

    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe('INVITE_RATE_LIMITED');
  });

  it('404s an unknown business', async () => {
    mockRows.push([]);

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));

    expect(res.status).toBe(404);
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });

  it('409s an account that is no longer pending_payment', async () => {
    seedOwnerRow({ subscription_status: SubscriptionStatus.ACTIVE });

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code?: string }).code).toBe('NOT_PENDING_PAYMENT');
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('502s when the provider sign-in lookup fails (never read as "never signed in")', async () => {
    seedOwnerRow();
    mockGetUserById.mockResolvedValueOnce({
      data: { user: null },
      error: { code: 'unexpected_failure', status: 500, message: 'boom' },
    });

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));

    expect(res.status).toBe(502);
    expect(((await res.json()) as { code?: string }).code).toBe('PROVIDER_UNAVAILABLE');
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });

  it('429s when the per-business resend cap is exhausted, without calling the provider', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    seedOwnerRow();

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));

    expect(res.status).toBe(429);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      `admin:resend-invite:business:${BUSINESS_ID}`,
      3,
      3600,
      { strict: true },
    );
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });

  it('503s when the strict rate limiter is unavailable (fail-closed)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('redis down'));
    seedOwnerRow();

    const res = await POST(makeRequest(), paramsFor(BUSINESS_ID));

    expect(res.status).toBe(503);
    expect(mockInviteUserByEmail).not.toHaveBeenCalled();
  });
});
