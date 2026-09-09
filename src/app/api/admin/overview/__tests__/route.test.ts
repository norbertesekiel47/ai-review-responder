// src/app/api/admin/overview/__tests__/route.test.ts
//
// #1184: this route folded from `requireRoleOr401` onto `requireAdminWithAal2`, so the
// REAL gate runs here and only its dependencies are mocked — through the shared shim,
// the single owner of that mock triple
// (src/lib/auth/__tests__/helpers/admin-gate-mocks.ts).
//
// Scope is deliberately narrow: the five gate cases every folded Admin API read owes,
// plus one success assertion that `getAdminOverview`'s result is returned unchanged.
// The overview query shapes belong to the service's own suite, so `sql` is a bare stub
// and there are no SQL fixtures here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockLoadAppUser,
  mockResolveDualModeIdentity,
  adminAuthModuleMock,
  mockGetAdminOverview,
  mockSql,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks, adminAuthModuleMock } =
    await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  return {
    ...makeAdminGateMocks(),
    adminAuthModuleMock,
    mockGetAdminOverview: vi.fn(),
    mockSql: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@/lib/admin/overview-service', () => ({
  getAdminOverview: mockGetAdminOverview,
}));

vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

vi.mock('@/lib/db/auth', () => adminAuthModuleMock(mockRequireRole, mockLoadAppUser));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

vi.mock('@/lib/auth/verified-identity', () => ({
  resolveDualModeIdentity: mockResolveDualModeIdentity,
}));

// Import AFTER mocks
import { GET } from '../route';

const ADMIN = { id: 'admin-1', role: 'admin', accountId: null, locationId: null };

// A stand-in for OverviewData: the point is that the handler returns the service's
// result byte-for-byte, not what the shape happens to be this week.
const OVERVIEW_FIXTURE = {
  totals: { businesses: 3, activeSubscriptions: 2 },
  atRisk: [{ id: 'biz-1', name: 'Test Cafe' }],
};

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/overview');
}

// ── The admin MFA gate on GET (#1184) ───────────────────────────────
//
// Each refusal also asserts the no-store header — that is what catches a fold which
// REWRAPS `gate.response` instead of returning it: the status and body would still
// look right while the cache semantics of an admin refusal silently changed.
describe('GET /api/admin/overview — the admin MFA gate (#1184)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ADMIN);
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockGetAdminOverview.mockResolvedValue(OVERVIEW_FIXTURE);
  });

  it('GET /api/admin/overview — an aal2 admin is served', async () => {
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    expect(mockResolveDualModeIdentity).toHaveBeenCalledOnce();
    // The negative half of the bearer case: no Authorization header, so the shim
    // must resolve cookie transport rather than a value it invented.
    const resolved = await mockResolveDualModeIdentity.mock.results[0]!.value;
    expect(resolved?.transport).toBe('cookie');
  });

  it('returns the service payload unchanged', async () => {
    const res = await GET(makeGetRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OVERVIEW_FIXTURE);
    expect(mockGetAdminOverview).toHaveBeenCalledWith(mockSql);
  });

  it('GET /api/admin/overview — an aal1 admin is refused 403 mfa_required', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminOverview).not.toHaveBeenCalled();
  });

  it('GET /api/admin/overview — a non-admin is refused 403 Forbidden', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminOverview).not.toHaveBeenCalled();
  });

  it('GET /api/admin/overview — an unauthenticated caller is refused 401 Unauthorized', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));

    const res = await GET(makeGetRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminOverview).not.toHaveBeenCalled();
  });

  it('GET /api/admin/overview — a bearer-transport aal2 admin is served', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/overview', {
      headers: { authorization: 'Bearer test-admin-access-token' },
    });

    const res = await GET(req);

    expect(res.status).toBe(200);
    // The seam saw the real header, so this is a transport test rather than a
    // second spelling of the cookie case.
    const seen = mockResolveDualModeIdentity.mock.calls[0]![0] as NextRequest;
    expect(seen.headers.get('authorization')).toBe('Bearer test-admin-access-token');
    // …and the transport the shim RESOLVED from it. Asserting only the header
    // above leaves a hardcoded `transport` in the shim passing every one of the
    // nine bearer cases, which is exactly the mutation this line kills.
    const resolved = await mockResolveDualModeIdentity.mock.results[0]!.value;
    expect(resolved?.transport).toBe('bearer');
  });
});
