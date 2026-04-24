import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockExchangeCodeForSession,
  mockSignOut,
  mockSingle,
  mockCreateServerClient,
} = vi.hoisted(() => {
  const single = vi.fn();
  const exchangeCodeForSession = vi.fn();
  const signOut = vi.fn();

  // Chainable query builder mock: .from().select().eq().limit().single()
  const makeQueryBuilder = () => {
    const qb: Record<string, unknown> = {};
    qb.select = vi.fn(() => qb);
    qb.eq = vi.fn(() => qb);
    qb.limit = vi.fn(() => qb);
    qb.single = single;
    return qb;
  };

  return {
    mockExchangeCodeForSession: exchangeCodeForSession,
    mockSignOut: signOut,
    mockSingle: single,
    mockCreateServerClient: vi.fn(() => ({
      auth: {
        exchangeCodeForSession,
        signOut,
      },
      from: vi.fn(() => makeQueryBuilder()),
    })),
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: mockCreateServerClient,
}));

// Env setup — must be set before importing the route.
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

// Import AFTER mocks + env.
import { GET } from '../callback/route';

// ── Helpers ─────────────────────────────────────────────────────────

function mkReq(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

function buildUrl(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `https://app.example.com/api/auth/callback${qs ? `?${qs}` : ''}`;
}

beforeEach(() => {
  mockExchangeCodeForSession.mockReset();
  mockExchangeCodeForSession.mockResolvedValue({
    data: { user: { id: 'auth-uuid-123' } },
    error: null,
  });

  mockSignOut.mockReset();
  mockSignOut.mockResolvedValue({ error: null });

  mockSingle.mockReset();
  mockSingle.mockResolvedValue({ data: { role: 'owner' }, error: null });

  mockCreateServerClient.mockClear();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /api/auth/callback', () => {
  // ── Missing code branch (role of `flow` on failure redirect URL) ──

  it('redirects to /login when code missing AND flow=owner', async () => {
    const res = await GET(mkReq(buildUrl({ flow: 'owner' })));
    expect(res.headers.get('Location')).toBe('https://app.example.com/login');
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('redirects to /admin/login when code missing AND flow=admin', async () => {
    const res = await GET(mkReq(buildUrl({ flow: 'admin' })));
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/admin/login',
    );
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  it('redirects to /admin/login when code missing AND no flow (loginUrlForFlow default — spec §3.5)', async () => {
    // Legacy callers (middleware redirects, manual URLs without ?flow=) land
    // on /admin/login. Owner flows always pass flow=owner explicitly.
    const res = await GET(mkReq(buildUrl({})));
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/admin/login',
    );
    expect(mockCreateServerClient).not.toHaveBeenCalled();
  });

  // ── exchangeCodeForSession error branch ──

  it('redirects to /login?error=auth_callback_failed on exchange error + flow=owner', async () => {
    mockExchangeCodeForSession.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'invalid or expired code' },
    });

    const res = await GET(
      mkReq(buildUrl({ code: 'bad-code', flow: 'owner' })),
    );
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/login?error=auth_callback_failed',
    );
  });

  it('redirects to /admin/login?error=auth_callback_failed on exchange error + flow=admin', async () => {
    mockExchangeCodeForSession.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: { message: 'invalid or expired code' },
    });

    const res = await GET(
      mkReq(buildUrl({ code: 'bad-code', flow: 'admin' })),
    );
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/admin/login?error=auth_callback_failed',
    );
  });

  // ── Reset-password branches (no role lookup) ──

  it('redirects to /reset-password with valid code + next=/reset-password (no role lookup)', async () => {
    const res = await GET(
      mkReq(
        buildUrl({
          code: 'valid-code',
          flow: 'owner',
          next: '/reset-password',
        }),
      ),
    );
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/reset-password',
    );
    // Reset branch MUST NOT query the users table.
    expect(mockSingle).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('redirects to /admin/reset-password with valid code + next=/admin/reset-password (no role lookup)', async () => {
    const res = await GET(
      mkReq(
        buildUrl({
          code: 'valid-code',
          flow: 'admin',
          next: '/admin/reset-password',
        }),
      ),
    );
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/admin/reset-password',
    );
    expect(mockSingle).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  // ── Google-signup branch: next=/signup/finish ──

  it('redirects to /signup/finish when next=/signup/finish AND no users row', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });

    const res = await GET(
      mkReq(
        buildUrl({
          code: 'valid-code',
          flow: 'owner',
          next: '/signup/finish',
        }),
      ),
    );
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/signup/finish',
    );
    // No signOut — we WANT the session kept so finish-signup can use it.
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('falls through to role routing when next=/signup/finish AND users row EXISTS', async () => {
    // owner already has a users row — signup/finish is stale, route by role.
    mockSingle.mockResolvedValueOnce({
      data: { role: 'owner' },
      error: null,
    });

    const res = await GET(
      mkReq(
        buildUrl({
          code: 'valid-code',
          flow: 'owner',
          next: '/signup/finish',
        }),
      ),
    );
    // /signup/finish is NOT a role-appropriate path for owner → falls back to /dashboard.
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/dashboard',
    );
  });

  // ── next=/onboarding/pay routing ──

  it('redirects to /onboarding/pay when owner role + next=/onboarding/pay', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { role: 'owner' },
      error: null,
    });

    const res = await GET(
      mkReq(
        buildUrl({
          code: 'valid-code',
          flow: 'owner',
          next: '/onboarding/pay',
        }),
      ),
    );
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/onboarding/pay',
    );
  });

  it('falls back to /admin/overview when admin role + next=/onboarding/pay (defense)', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { role: 'admin' },
      error: null,
    });

    const res = await GET(
      mkReq(
        buildUrl({
          code: 'valid-code',
          flow: 'admin',
          next: '/onboarding/pay',
        }),
      ),
    );
    // /onboarding/pay isn't an admin path → ignore + default to /admin/overview.
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/admin/overview',
    );
  });

  // ── account_incomplete branches ──

  it('signOut + redirects to /login?error=account_incomplete when no users row + flow=owner + next !== /signup/finish', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });

    const res = await GET(
      mkReq(buildUrl({ code: 'valid-code', flow: 'owner' })),
    );
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/login?error=account_incomplete',
    );
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('signOut + redirects to /admin/login?error=account_incomplete when no users row + flow=admin + next !== /signup/finish', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });

    const res = await GET(
      mkReq(buildUrl({ code: 'valid-code', flow: 'admin' })),
    );
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/admin/login?error=account_incomplete',
    );
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  // ── Existing behavior preserved ──

  it('redirects owner to /dashboard with valid code + no next', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { role: 'owner' },
      error: null,
    });

    const res = await GET(mkReq(buildUrl({ code: 'valid-code' })));
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/dashboard',
    );
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('redirects admin to /admin/overview with valid code + no next', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { role: 'admin' },
      error: null,
    });

    const res = await GET(mkReq(buildUrl({ code: 'valid-code' })));
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/admin/overview',
    );
  });

  it('redirects sales_partner to /admin/overview with valid code + no next', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { role: 'sales_partner' },
      error: null,
    });

    const res = await GET(mkReq(buildUrl({ code: 'valid-code' })));
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/admin/overview',
    );
  });

  it('honors owner-appropriate next paths (/dashboard, /settings, /onboarding)', async () => {
    mockSingle.mockResolvedValue({
      data: { role: 'owner' },
      error: null,
    });

    for (const path of ['/dashboard/reviews', '/settings/billing', '/onboarding/pay']) {
      const res = await GET(
        mkReq(buildUrl({ code: 'valid-code', flow: 'owner', next: path })),
      );
      expect(res.headers.get('Location')).toBe(
        `https://app.example.com${path}`,
      );
    }
  });

  it('rejects unsafe next (//external) and falls back to role default', async () => {
    mockSingle.mockResolvedValueOnce({
      data: { role: 'owner' },
      error: null,
    });

    const res = await GET(
      mkReq(buildUrl({ code: 'valid-code', next: '//evil.example.com' })),
    );
    // Unsafe next is discarded; owner falls back to /dashboard.
    expect(res.headers.get('Location')).toBe(
      'https://app.example.com/dashboard',
    );
  });
});
