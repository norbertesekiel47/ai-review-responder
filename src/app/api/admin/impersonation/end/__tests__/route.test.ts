import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockVerifyImpersonationSession,
  mockEndImpersonationSession,
  mockSql,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockRequireCurrentAal2FromSupabase: vi.fn(),
  mockVerifyImpersonationSession: vi.fn(),
  mockEndImpersonationSession: vi.fn(),
  // The route now imports the @/lib/db/server singleton to pass `sql` into
  // endImpersonationSession (A+ campaign 2b, T4). endImpersonationSession
  // itself is mocked below, so this identity token is never queried directly.
  mockSql: {} as const,
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  // #1183: the admin gate maps a resolved identity to its users row instead of
  // calling requireRole. mockRequireRole still drives both outcomes — a 401
  // rejection becomes "no identity" (see the verified-identity mock below), a 403
  // becomes "authenticated but not an admin" here.
  // resolveDualModeIdentity below already made the ONE mockRequireRole call the
  // gate is entitled to; calling it again here would swallow a `...Once` control
  // (a mockRejectedValueOnce(403) would land on the seam and never reach this
  // step). Reuse that same outcome instead of consuming a second one.
  loadAppUser: async () => {
    const last = mockRequireRole.mock.results.at(-1);
    if (!last) return null;
    try {
      return await last.value;
    } catch {
      return null;
    }
  },
  cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

// #1183: the admin gate reads its identity through the Admin transport seam. This
// shim keeps the suite's existing controls meaningful — mockRequireRole still says
// whether there is a live admin, and mockRequireCurrentAal2FromSupabase still says
// whether the AAL2 step-up passed.
vi.mock('@/lib/auth/verified-identity', () => ({
  resolveDualModeIdentity: async (request: unknown) => {
    try {
      await mockRequireRole(request, 'admin');
    } catch (err) {
      const status = (err as { statusCode?: number } | null)?.statusCode;
      if (status === 401) return null; // no live credential → the gate's 401
      if (status !== 403) throw err; // a real fault → the gate's 500
      // 403 is "authenticated but not an admin"; loadAppUser reports that.
    }
    const aal = await mockRequireCurrentAal2FromSupabase();
    return {
      authUserId: 'auth-1',
      aal: aal?.ok ? 'aal2' : aal?.reason === 'mfa_check_failed' ? null : 'aal1',
      transport: 'cookie',
    };
  },
}));

vi.mock('@/lib/admin/impersonation/cookie', () => ({
  IMPERSONATION_COOKIE_NAME: 'rw_impersonation',
  verifyImpersonationSession: mockVerifyImpersonationSession,
}));

vi.mock('@/lib/admin/impersonation/session', () => ({
  endImpersonationSession: mockEndImpersonationSession,
}));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '44444444-4444-7444-8444-444444444444';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/impersonation/end', {
    method: 'POST',
    headers: {
      origin: 'https://app.example.com',
      cookie: 'rw_impersonation=signed-cookie',
      ...headers,
    },
  });
}

describe('POST /api/admin/impersonation/end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID,
      role: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockVerifyImpersonationSession.mockReturnValue(SESSION_ID);
    mockEndImpersonationSession.mockResolvedValue({ ended: true });
  });

  it('requires same-origin admin AAL2 and a valid signed impersonation cookie', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await import('../route');

    const csrfRes = await POST(req({ origin: 'https://evil.example.com' }));
    expect(csrfRes.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();

    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const roleRes = await POST(req());
    expect(roleRes.status).toBe(403);

    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID,
      role: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({
      ok: false,
      reason: 'mfa_required',
    });
    const aalRes = await POST(req());
    expect(aalRes.status).toBe(403);
    expect(await aalRes.json()).toEqual({ error: 'mfa_required' });

    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockVerifyImpersonationSession.mockReturnValueOnce(null);
    const cookieRes = await POST(req());
    expect(cookieRes.status).toBe(400);
    expect(await cookieRes.json()).toEqual({ error: 'invalid_impersonation_session' });
    expect(mockEndImpersonationSession).not.toHaveBeenCalled();
  });

  it('does not end a DB session when cookie verification cannot run', async () => {
    const { POST } = await import('../route');
    mockVerifyImpersonationSession.mockImplementationOnce(() => {
      throw new Error('IMPERSONATION_COOKIE_SECRET not configured');
    });

    const res = await POST(req());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(mockEndImpersonationSession).not.toHaveBeenCalled();
  });

  it('ends the current session and clears the impersonation cookie', async () => {
    const { POST } = await import('../route');

    const res = await POST(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockVerifyImpersonationSession).toHaveBeenCalledWith('signed-cookie');
    expect(mockEndImpersonationSession).toHaveBeenCalledWith(mockSql, {
      sessionId: SESSION_ID,
      actorUserId: ADMIN_ID,
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('rw_impersonation=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toMatch(/;\s*Path=\/(?:;|$)/);
  });
});
