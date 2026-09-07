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
  mockWriteAdminAudit,
  mockReportCaughtError,
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
  mockWriteAdminAudit: vi.fn(),
  mockReportCaughtError: vi.fn(),
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
  writeAdminAuditLog: mockWriteAdminAudit,
}));

vi.mock('@/lib/shared/report-caught-error', () => ({
  reportCaughtError: mockReportCaughtError,
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
    mockWriteAdminAudit.mockResolvedValue(undefined);
    mockSetSupabaseCookies.value = false;
  });

  const verifyBody = {
    action: 'verify',
    factorId: 'factor-1',
    challengeId: 'challenge-1',
    code: '123456',
  } as const;

  function asAdmin(): void {
    mockSql.mockResolvedValue([{ id: 'admin-1', account_id: null, role: 'admin' }]);
  }

  function withFactors(factors: unknown): void {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-user-1', factors } } });
  }

  // ── #468: the admin path (role='admin', NULL account_id) ──────────────────

  it('routes an admin unenroll to admin_audit_log, never to account_audit_log', async () => {
    asAdmin();

    const res = await POST(req({ action: 'unenroll', factorId: 'factor-1' }));

    expect(res.status).toBe(200);
    expect(mockWriteAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: 'admin-1',
        eventType: 'mfa_factor_unenrolled',
        payload: { factor_id: 'factor-1' },
      }),
    );
    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockReportCaughtError).not.toHaveBeenCalled();
  });

  it('routes an admin failed verify to admin_audit_log', async () => {
    asAdmin();
    withFactors([{ id: 'factor-1', status: 'verified' }]);
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'bad code' } });

    const res = await POST(req(verifyBody));

    expect(res.status).toBe(400);
    expect(mockWriteAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: 'admin-1',
        eventType: 'mfa_challenge_failed',
        payload: { factor_id: 'factor-1', factor_status_before: 'verified' },
      }),
    );
    expect(mockWriteAudit).not.toHaveBeenCalled();
  });

  it('records an admin verify on an unverified factor as mfa_factor_enrolled', async () => {
    asAdmin();
    withFactors([{ id: 'factor-1', status: 'unverified' }]);

    const res = await POST(req(verifyBody));

    expect(res.status).toBe(200);
    expect(mockWriteAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: 'admin-1',
        eventType: 'mfa_factor_enrolled',
        payload: { factor_id: 'factor-1', factor_status_before: 'unverified' },
      }),
    );
    // Admins never get the owner fresh-auth cookie.
    expect(res.headers.get('set-cookie') ?? '').not.toContain(`${FRESH_AUTH_COOKIE_NAME}=`);
  });

  it('records an admin verify on a verified factor as mfa_challenge_succeeded', async () => {
    asAdmin();
    withFactors([{ id: 'factor-1', status: 'verified' }]);

    await POST(req(verifyBody));

    expect(mockWriteAdminAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'mfa_challenge_succeeded',
        payload: { factor_id: 'factor-1', factor_status_before: 'verified' },
      }),
    );
  });

  it('issues ONE users lookup per request even when both the audit and the fresh-auth cookie need the actor', async () => {
    withFactors([{ id: 'factor-1', status: 'verified' }]);

    const res = await POST(req(verifyBody));

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain(`${FRESH_AUTH_COOKIE_NAME}=`);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // ── enrollment vs step-up for owners (same code path) ────────────────────

  it('records an owner verify on an unverified factor as mfa_factor_enrolled against the account', async () => {
    withFactors([{ id: 'factor-1', status: 'unverified' }]);

    await POST(req(verifyBody));

    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        actorUserId: 'user-1',
        eventType: 'mfa_factor_enrolled',
        payload: { factor_id: 'factor-1', factor_status_before: 'unverified' },
      }),
    );
    expect(mockWriteAdminAudit).not.toHaveBeenCalled();
  });

  it('falls back to mfa_challenge_succeeded with factor_status_before=unknown when user.factors is absent', async () => {
    const res = await POST(req(verifyBody));

    expect(res.status).toBe(200);
    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'mfa_challenge_succeeded',
        payload: { factor_id: 'factor-1', factor_status_before: 'unknown' },
      }),
    );
  });

  it('reads the factor status BEFORE verify (the id must be looked up, not the post-verify state)', async () => {
    withFactors([{ id: 'other-factor', status: 'unverified' }]);

    await POST(req(verifyBody));

    expect(mockWriteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'mfa_challenge_succeeded',
        payload: { factor_id: 'factor-1', factor_status_before: 'unknown' },
      }),
    );
  });

  // ── unroutable actors + best-effort ──────────────────────────────────────

  it('writes NO audit row for a non-admin with no account and reports it, without blocking the action', async () => {
    mockSql.mockResolvedValue([{ id: 'user-x', account_id: null, role: 'owner' }]);

    const res = await POST(req({ action: 'unenroll', factorId: 'factor-1' }));

    expect(res.status).toBe(200);
    expect(mockWriteAudit).not.toHaveBeenCalled();
    expect(mockWriteAdminAudit).not.toHaveBeenCalled();
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'mfa-challenge',
      expect.any(Error),
      expect.objectContaining({ reason: 'audit_actor_unroutable', eventType: 'mfa_factor_unenrolled', role: 'owner' }),
    );
  });

  it('writes NO audit row when the auth user has no users row, and reports it', async () => {
    mockSql.mockResolvedValue([]);

    const res = await POST(req({ action: 'unenroll', factorId: 'factor-1' }));

    expect(res.status).toBe(200);
    expect(mockWriteAdminAudit).not.toHaveBeenCalled();
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'mfa-challenge',
      expect.any(Error),
      expect.objectContaining({ reason: 'audit_actor_unroutable', role: null }),
    );
  });

  it('keeps the admin action successful when the admin audit write rejects (best-effort)', async () => {
    asAdmin();
    mockWriteAdminAudit.mockRejectedValueOnce(new Error('relation "admin_audit_log" does not exist'));

    const res = await POST(req({ action: 'unenroll', factorId: 'factor-1' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'mfa-challenge',
      expect.any(Error),
      expect.objectContaining({ reason: 'audit_write_failed', eventType: 'mfa_factor_unenrolled' }),
    );
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
