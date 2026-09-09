import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────
//
// #1184: this route folded from `requireRoleOr401` onto `requireAdminWithAal2`, so
// the REAL gate runs here and only its dependencies are mocked — through the shared
// shim, the single owner of that mock triple
// (src/lib/auth/__tests__/helpers/admin-gate-mocks.ts). `mockRequireRole` says
// whether there is a live admin; `mockRequireCurrentAal2FromSupabase` says whether
// the AAL2 step-up passed.
//
// The shim must be reached through a `vi.hoisted` dynamic import: `vi.mock`
// factories hoist above imports, so a plain top-level import referenced from a
// factory is a TDZ error at collection time.
const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockLoadAppUser,
  mockResolveDualModeIdentity,
  mockGetAdminNotifications,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks } = await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  return {
    ...makeAdminGateMocks(),
    mockGetAdminNotifications: vi.fn(),
  };
});

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    loadAppUser: mockLoadAppUser,
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

vi.mock('@/lib/auth/verified-identity', () => ({
  resolveDualModeIdentity: mockResolveDualModeIdentity,
}));

vi.mock('@/lib/admin/notifications-service', () => ({
  getAdminNotifications: (...args: unknown[]) => mockGetAdminNotifications(...args),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

// ── Helpers ─────────────────────────────────────────────────────────

const ADMIN = { id: 'admin-1', role: 'admin', accountId: null, locationId: null };

const SERVICE_RESULT = {
  notifications: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      businessName: 'Acme Dental',
      channel: 'email',
      recipient: 'owner@example.com',
      template: 'approval_request',
      sentAt: '2026-06-01T12:00:00.000Z',
      deliveredAt: '2026-06-01T12:00:05.000Z',
      failedAt: null,
      failureReason: null,
      createdAt: '2026-06-01T11:59:00.000Z',
    },
  ],
  total: 1,
  businesses: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Acme Dental' }],
};

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/notifications');
}

function bearerRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/notifications', {
    headers: { authorization: 'Bearer test-admin-access-token' },
  });
}

// ── Tests ───────────────────────────────────────────────────────────
//
// Each refusal also asserts the no-store header. That is what catches a fold that
// REWRAPS `gate.response` instead of returning it — the status and the body would
// still look right while the cache semantics of an admin refusal silently changed.
describe('GET /api/admin/notifications — the admin MFA gate (#1184)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ADMIN);
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockGetAdminNotifications.mockResolvedValue(SERVICE_RESULT);
  });

  it('GET /api/admin/notifications — an aal2 admin is served', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockResolveDualModeIdentity).toHaveBeenCalledOnce();
  });

  it('returns the service result unchanged, with limit/offset echoed', async () => {
    const { GET } = await import('../route');
    const res = await GET(
      new NextRequest('http://localhost:3000/api/admin/notifications?limit=50&offset=10'),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...SERVICE_RESULT, limit: 50, offset: 10 });
    expect(mockGetAdminNotifications).toHaveBeenCalledOnce();
  });

  it('GET /api/admin/notifications — an aal1 admin is refused 403 mfa_required', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminNotifications).not.toHaveBeenCalled();
  });

  it('GET /api/admin/notifications — a non-admin is refused 403 Forbidden', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminNotifications).not.toHaveBeenCalled();
  });

  it('GET /api/admin/notifications — an unauthenticated caller is refused 401 Unauthorized', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminNotifications).not.toHaveBeenCalled();
  });

  it('GET /api/admin/notifications — a bearer-transport aal2 admin is served', async () => {
    const { GET } = await import('../route');
    const res = await GET(bearerRequest());

    expect(res.status).toBe(200);
    // The seam saw the real header, so this is a transport test rather than a
    // second spelling of the cookie case.
    const seen = mockResolveDualModeIdentity.mock.calls[0]![0] as NextRequest;
    expect(seen.headers.get('authorization')).toBe('Bearer test-admin-access-token');
  });
});
