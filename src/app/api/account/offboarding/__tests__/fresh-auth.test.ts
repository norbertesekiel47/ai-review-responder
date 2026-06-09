import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const {
  mockRequireOwnerWithAccount,
  mockCheckRateLimit,
  mockSignInWithPassword,
  mockSupabaseSetAll,
} = vi.hoisted(() => ({
  mockRequireOwnerWithAccount: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockSignInWithPassword: vi.fn(),
  mockSupabaseSetAll: vi.fn(),
}));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    requireOwnerWithAccount: mockRequireOwnerWithAccount,
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: {
    cookies?: {
      setAll?: (cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => void;
    };
  }) => {
    mockSupabaseSetAll.mockImplementation(() => {
      options.cookies?.setAll?.([
        { name: 'sb-auth-token', value: 'updated', options: { path: '/' } },
      ]);
    });
    return {
      auth: {
        signInWithPassword: async (...args: unknown[]) => {
          mockSupabaseSetAll();
          return mockSignInWithPassword(...args);
        },
      },
    };
  }),
}));

import { FRESH_AUTH_COOKIE_NAME } from '@/lib/account-offboarding/destructive-auth';
import { POST } from '../fresh-auth/route';

const APP_URL = 'https://app.example.com';
const ACCOUNT_ID = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const USER_ID = '11111111-2222-7333-8444-555555555555';

function ownerUser() {
  return {
    id: USER_ID,
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: '99999999-8888-7777-8666-555555555555',
  };
}

function req(
  body: unknown = { password: 'correct horse battery staple' },
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${APP_URL}/api/account/offboarding/fresh-auth`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: APP_URL,
      'x-forwarded-for': '203.0.113.9',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/offboarding/fresh-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.example.com');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'true');
    vi.stubEnv('SESSION_COOKIE_SECRET', 'test-session-cookie-secret-at-least-32-chars');
    mockRequireOwnerWithAccount.mockResolvedValue({
      ok: true,
      user: ownerUser(),
      accountId: ACCOUNT_ID,
    });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mockSignInWithPassword.mockResolvedValue({ data: { user: { id: 'auth-user-1' } }, error: null });
  });

  it('returns 404 and does not auth when account offboarding is disabled', async () => {
    vi.stubEnv('ACCOUNT_OFFBOARDING_ENABLED', 'false');

    const res = await POST(req());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'account_offboarding_disabled' });
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it('rejects cross-origin requests before owner auth', async () => {
    const res = await POST(req(undefined, { origin: 'https://evil.example.com' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it('returns the owner auth failure when no session is present', async () => {
    mockRequireOwnerWithAccount.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });

    const res = await POST(req());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it('requires a password body before calling Supabase', async () => {
    const res = await POST(req({ password: '' }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it('rate-limits password reauth per owner and IP before checking the password', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(req());

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      `account-offboarding:fresh-auth:${USER_ID}:ip:203.0.113.9`,
      5,
      15 * 60,
      { strict: true },
    );
    expect(mockSignInWithPassword).not.toHaveBeenCalled();
  });

  it('returns invalid credentials without stamping fresh auth when the password is wrong', async () => {
    mockSignInWithPassword.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'Invalid login credentials' },
    });

    const res = await POST(req({ password: 'wrong-password' }));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(res.headers.get('set-cookie') ?? '').not.toContain(FRESH_AUTH_COOKIE_NAME);
  });

  it('verifies the password for the current owner email and sets a server-owned fresh-auth stamp', async () => {
    const res = await POST(req({ password: 'correct horse battery staple' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain('sb-auth-token=updated');
    expect(setCookie).toContain(`${FRESH_AUTH_COOKIE_NAME}=`);
    expect(setCookie).toContain('Max-Age=600');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
  });
});
