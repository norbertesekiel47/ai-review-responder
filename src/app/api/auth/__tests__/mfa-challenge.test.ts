import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockCheckRateLimit,
  mockGetUser,
  mockChallenge,
  mockVerify,
  mockUnenroll,
  mockGetAal,
  mockSql,
  mockWriteAudit,
  mockSetSupabaseCookies,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockGetUser: vi.fn(),
  mockChallenge: vi.fn(),
  mockVerify: vi.fn(),
  mockUnenroll: vi.fn(),
  mockGetAal: vi.fn(),
  mockSql: vi.fn(),
  mockWriteAudit: vi.fn(),
  mockSetSupabaseCookies: { value: false },
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  sql: (...args: unknown[]) => mockSql(...args),
}));

vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAudit,
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
          unenroll: mockUnenroll,
          getAuthenticatorAssuranceLevel: mockGetAal,
        },
      },
    };
  }),
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
process.env.SESSION_COOKIE_SECRET = 'test-session-cookie-secret-at-least-32-chars';

import { POST } from '../mfa/challenge/route';
import { FRESH_AUTH_COOKIE_NAME } from '@/lib/account-offboarding/destructive-auth';

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
    mockUnenroll.mockResolvedValue({ data: {}, error: null });
    mockGetAal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });
    mockSql.mockResolvedValue([{ id: 'user-1', account_id: 'acct-1', role: 'owner' }]);
    mockWriteAudit.mockResolvedValue(undefined);
    mockSetSupabaseCookies.value = false;
  });

  it('rate-limits challenge under a challenge-specific key', async () => {
    const res = await POST(req({ action: 'challenge', factorId: 'factor-1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challengeId: 'challenge-1' });
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'mfa:challenge:auth-user-1:factor-1',
      expect.any(Number),
      15 * 60,
      { strict: true },
    );
    expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-1' });
  });

  it('rate-limits verify under a SEPARATE key so challenge does not consume verify budget', async () => {
    await POST(req({
      action: 'verify',
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '123456',
    }));

    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'mfa:verify:auth-user-1:factor-1',
      expect.any(Number),
      15 * 60,
      { strict: true },
    );
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

  it('stamps fresh auth after a successful MFA verification for account owners', async () => {
    const res = await POST(req({
      action: 'verify',
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '123456',
    }));

    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${FRESH_AUTH_COOKIE_NAME}=`);
    expect(setCookie).toContain('Max-Age=600');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
    expect(setCookie).toMatch(/;\s*Path=\/(?:;|$)/);
  });

  it('audits a failed verify as mfa_challenge_failed', async () => {
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'bad code' } });

    const res = await POST(req({
      action: 'verify',
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '000000',
    }));

    expect(res.status).toBe(400);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        actorUserId: 'user-1',
        eventType: 'mfa_challenge_failed',
      }),
    );
  });

  it('blocks unenroll when the current session is not AAL2', async () => {
    mockGetAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null });

    const res = await POST(req({ action: 'unenroll', factorId: 'factor-1' }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(mockUnenroll).not.toHaveBeenCalled();
  });

  it('unenrolls at AAL2 and writes an mfa_factor_unenrolled audit row', async () => {
    const res = await POST(req({ action: 'unenroll', factorId: 'factor-1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-1' });
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        actorUserId: 'user-1',
        eventType: 'mfa_factor_unenrolled',
      }),
    );
  });
});
