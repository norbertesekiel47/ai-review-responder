import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockCheckRateLimit,
  mockSql,
  mockGetUser,
  mockUpdateUser,
  mockSignOut,
  mockGetAal,
  mockCreateServerClient,
} = vi.hoisted(() => {
  const sqlFn = vi.fn();
  const getUser = vi.fn();
  const updateUser = vi.fn();
  const signOut = vi.fn();
  const getAal = vi.fn();
  return {
    mockCheckRateLimit: vi.fn(),
    mockSql: sqlFn,
    mockGetUser: getUser,
    mockUpdateUser: updateUser,
    mockSignOut: signOut,
    mockGetAal: getAal,
    mockCreateServerClient: vi.fn(() => ({
      auth: {
        getUser,
        updateUser,
        signOut,
        mfa: { getAuthenticatorAssuranceLevel: getAal },
      },
    })),
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
  supabaseServer: {
    // Not used in reset-password — present only to satisfy imports that may
    // transitively touch this module.
    auth: { admin: { deleteUser: vi.fn() } },
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: mockCreateServerClient,
}));

// Flag + env setup — must be set before importing the route.
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

// Import AFTER mocks + env.
import { POST } from '../reset-password/route';

// ── Helpers ─────────────────────────────────────────────────────────

function mkReq(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/reset-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://app.example.com',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// Default session user.
const mockUser = {
  id: 'auth-uuid-123',
  email: 'owner@example.com',
};

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });

  mockSql.mockReset();
  // Default: users row returns role='owner'.
  mockSql.mockResolvedValue([{ role: 'owner' }]);

  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });

  mockUpdateUser.mockReset();
  mockUpdateUser.mockResolvedValue({ data: { user: mockUser }, error: null });

  mockSignOut.mockReset();
  mockSignOut.mockResolvedValue({ error: null });

  mockGetAal.mockReset();
  // Default fixture: an account with NO enrolled factor. GoTrue reports
  // nextLevel 'aal1' for these, which is what makes every pre-existing test in
  // this file exercise the unchanged pass-through path.
  mockGetAal.mockResolvedValue({
    data: { currentLevel: 'aal1', nextLevel: 'aal1' },
    error: null,
  });

  mockCreateServerClient.mockReset();
  mockCreateServerClient.mockImplementation(() => ({
    auth: {
      getUser: mockGetUser,
      updateUser: mockUpdateUser,
      signOut: mockSignOut,
      mfa: { getAuthenticatorAssuranceLevel: mockGetAal },
    },
  }));

  process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
});

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/auth/reset-password', () => {
  // ── CSRF / same-origin ───────────────────────────────────────────

  it('returns 403 when Origin header mismatches NEXT_PUBLIC_APP_URL', async () => {
    const res = await POST(
      mkReq(
        { password: 'a-new-strong-password' },
        { origin: 'https://evil.example.com' },
      ),
    );
    expect(res.status).toBe(403);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ── Auth / session ───────────────────────────────────────────────

  it('returns 401 when no session cookie (getUser returns { user: null })', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('returns 500 account_incomplete when session exists but no users row for auth_id', async () => {
    mockSql.mockResolvedValueOnce([]); // no row
    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('account_incomplete');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ── Role-based flag gate ─────────────────────────────────────────

  it('returns 404 when flag off AND session user role=owner', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(404);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockGetAal).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('returns 200 + calls updateUser when flag off AND session role=admin (admins never gated)', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    mockSql.mockResolvedValueOnce([{ role: 'admin' }]);

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith({
      password: 'a-new-strong-password',
    });
    const json = await res.json();
    expect(json.redirectTo).toBe('/admin/login');
  });

  it('returns 200 + calls updateUser when flag on AND owner session', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith({
      password: 'a-new-strong-password',
    });
    const json = await res.json();
    expect(json.redirectTo).toBe('/login');
  });

  // ── Validation ───────────────────────────────────────────────────

  it('returns 400 on weak password (< 8 chars)', async () => {
    const res = await POST(mkReq({ password: 'short' }));
    expect(res.status).toBe(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('returns 400 when Supabase updateUser returns error', async () => {
    mockUpdateUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: 'New password should be different from the old one.' },
    });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('New password should be different from the old one.');
    // Recovery session must remain active on failure so the user can retry.
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  // ── Recovery-session termination ─────────────────────────────────

  it('calls signOut after updateUser succeeds (ends recovery session)', async () => {
    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);

    // Order matters: signOut must run AFTER updateUser. Both resolved
    // ordering comes from the mock invocation order.
    const updateCallOrder = mockUpdateUser.mock.invocationCallOrder[0]!;
    const signOutCallOrder = mockSignOut.mock.invocationCallOrder[0]!;
    expect(signOutCallOrder).toBeGreaterThan(updateCallOrder);
  });

  // ── Role-appropriate redirect ────────────────────────────────────

  it('returns 200 + { redirectTo: "/login" } for owner role', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'owner' }]);

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/login');
  });

  it('returns 200 + { redirectTo: "/admin/login" } for admin role', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'admin' }]);

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.redirectTo).toBe('/admin/login');
  });

  it('returns 403 unsupported_role and signs out for sales_partner role', async () => {
    mockSql.mockResolvedValueOnce([{ role: 'sales_partner' }]);

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('unsupported_role');
    expect(json.redirectTo).toBe('/admin/login');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockGetAal).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ── Rate limiting ────────────────────────────────────────────────

  it('returns 429 on rate-limit exceeded (per-authId 5/hr)', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(429);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('uses strict:true with key reset-pw:auth:<authId> at 5/hr', async () => {
    await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    const call = mockCheckRateLimit.mock.calls[0]!;
    expect(call[0]).toBe('reset-pw:auth:auth-uuid-123');
    expect(call[1]).toBe(5);
    expect(call[2]).toBe(3600);
    expect(call[3]).toEqual({ strict: true });
  });

  it('returns 503 on strict rate-limit failure (Redis down)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(503);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  // ── MFA step-up gate ─────────────────────────────────────────────

  it('returns 403 mfa_required and NEVER calls updateUser when a factor is enrolled but unchallenged', async () => {
    mockGetAal.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('mfa_required');
    // The ABSENCE of the write is the point of this test. A status-only
    // assertion would also pass against the shipped bug, where the route
    // reached GoTrue and merely relabelled the refusal.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('proceeds normally when the session is already AAL2', async () => {
    mockGetAal.mockResolvedValueOnce({
      data: { currentLevel: 'aal2', nextLevel: 'aal2' },
      error: null,
    });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith({
      password: 'a-new-strong-password',
    });
  });

  it('fails CLOSED with 403 mfa_check_failed when the AAL probe errors', async () => {
    mockGetAal.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('mfa_check_failed');
    // An unreadable AAL is not permission to write a password.
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('fails CLOSED with 403 mfa_check_failed when the AAL probe throws', async () => {
    mockGetAal.mockRejectedValueOnce(new Error('decodeJWT boom'));
    const res = await POST(mkReq({ password: 'a-new-strong-password' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('mfa_check_failed');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('runs the rate limit BEFORE the AAL probe so a prober spends its own budget', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await POST(mkReq({ password: 'a-new-strong-password' }));

    expect(res.status).toBe(429);
    expect(mockGetAal).not.toHaveBeenCalled();
  });

  it('refuses the step-up BEFORE parsing the body, so a refused request never reads the password', async () => {
    mockGetAal.mockResolvedValueOnce({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    });

    // A body that would fail schema validation with 400 if it were ever parsed.
    const res = await POST(mkReq({ password: 'short' }));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('mfa_required');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });
});
