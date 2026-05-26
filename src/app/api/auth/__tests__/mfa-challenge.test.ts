import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockCheckRateLimit,
  mockGetUser,
  mockChallenge,
  mockVerify,
  mockSetSupabaseCookies,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockGetUser: vi.fn(),
  mockChallenge: vi.fn(),
  mockVerify: vi.fn(),
  mockSetSupabaseCookies: { value: false },
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: {
    cookies?: {
      setAll?: (cookies: Array<{ name: string; value: string; options?: Record<string, unknown> }>) => void;
    };
  }) => {
    if (mockSetSupabaseCookies.value) {
      options.cookies?.setAll?.([
        { name: 'sb-refresh-token', value: 'updated', options: { path: '/' } },
      ]);
    }
    return {
      auth: {
        getUser: mockGetUser,
        mfa: {
          challenge: mockChallenge,
          verify: mockVerify,
        },
      },
    };
  }),
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

import { POST } from '../mfa/challenge/route';

function req(body: unknown): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/mfa/challenge', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/mfa/challenge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-user-1' } } });
    mockChallenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValue({ data: {}, error: null });
    mockSetSupabaseCookies.value = false;
  });

  it('rate-limits and creates an MFA challenge for the current session', async () => {
    const res = await POST(req({ action: 'challenge', factorId: 'factor-1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challengeId: 'challenge-1' });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'mfa_challenge:auth-user-1:factor-1',
      5,
      15 * 60,
      { strict: true },
    );
    expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-1' });
  });

  it('copies refreshed Supabase cookies on challenge success', async () => {
    mockSetSupabaseCookies.value = true;

    const res = await POST(req({ action: 'challenge', factorId: 'factor-1' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('sb-refresh-token=updated');
  });

  it('rate-limits verify attempts before calling Supabase verify', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(req({
      action: 'verify',
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '123456',
    }));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('verifies a code through Supabase when rate limit allows it', async () => {
    const res = await POST(req({
      action: 'verify',
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '123456',
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockVerify).toHaveBeenCalledWith({
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '123456',
    });
  });
});
