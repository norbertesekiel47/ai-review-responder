import { adminBearerRequest } from '@/lib/auth/__tests__/helpers/admin-gate-mocks';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────
//
// #1184: this route folded from `requireRoleOr401` onto `requireAdminWithAal2`.
// The `@/lib/auth/route-helpers` mock this suite used to carry is GONE on purpose —
// with it in place the new gate assertions would be vacuous, because no
// authorization code would run at all. The REAL gate now runs here and only its
// dependencies are mocked, through the shared shim that owns that mock triple
// (src/lib/auth/__tests__/helpers/admin-gate-mocks.ts): `mockRequireRole` says
// whether there is a live admin, `mockRequireCurrentAal2FromSupabase` says whether
// the AAL2 step-up passed.
//
// The shim must be reached through a `vi.hoisted` dynamic import: `vi.mock`
// factories hoist above imports, so a plain top-level import referenced from a
// factory is a TDZ error at collection time.
const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockLoadAppUser,
  mockResolveAdminApiIdentity,
  adminAuthModuleMock,
  mockGetAdminNavCounts,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks, adminAuthModuleMock } =
    await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  return {
    ...makeAdminGateMocks(),
    adminAuthModuleMock,
    mockGetAdminNavCounts: vi.fn(),
  };
});

vi.mock('@/lib/db/auth', () => adminAuthModuleMock(mockRequireRole, mockLoadAppUser));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

vi.mock('@/lib/auth/verified-identity', () => ({
  resolveAdminApiIdentity: mockResolveAdminApiIdentity,
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('@/lib/admin/nav-counts-service', () => ({ getAdminNavCounts: mockGetAdminNavCounts }));
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

import { GET } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

const ADMIN = { id: 'admin-1', role: 'admin', accountId: null, locationId: null };

function request(): NextRequest {
  return adminBearerRequest('http://localhost/api/admin/nav-counts');
}

function bearerRequest(): NextRequest {
  return adminBearerRequest('http://localhost/api/admin/nav-counts', {
    headers: { authorization: 'Bearer test-admin-access-token' },
  });
}

describe('GET /api/admin/nav-counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ADMIN);
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
  });

  it('returns 401 when the admin gate rejects', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockGetAdminNavCounts).not.toHaveBeenCalled();
  });

  it('returns the counts with no-store caching', async () => {
    mockGetAdminNavCounts.mockResolvedValue({ flaggedOpen: 3, failedJobs: 1 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ flaggedOpen: 3, failedJobs: 1 });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 500 when the service throws', async () => {
    mockGetAdminNavCounts.mockRejectedValue(new Error('db down'));

    const response = await GET(request());

    expect(response.status).toBe(500);
  });
});

// ── #1184: the fold onto requireAdminWithAal2 ───────────────────────
//
// Each refusal also asserts the no-store header. That is what catches a fold that
// REWRAPS `gate.response` instead of returning it — the status and the body would
// still look right while the cache semantics of an admin refusal silently changed.
describe('GET /api/admin/nav-counts — the admin MFA gate (#1184)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ADMIN);
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockGetAdminNavCounts.mockResolvedValue({ flaggedOpen: 3, failedJobs: 1 });
  });

  it('GET /api/admin/nav-counts — an aal2 admin is served', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockResolveAdminApiIdentity).toHaveBeenCalledOnce();
    // The route fixture supplies a bearer; ordinary Admin APIs no longer accept cookies.
    const resolved = await mockResolveAdminApiIdentity.mock.results[0]!.value;
    expect(resolved?.transport).toBe('bearer');
  });

  it('GET /api/admin/nav-counts — an aal1 admin is refused 403 mfa_required', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'mfa_required' });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminNavCounts).not.toHaveBeenCalled();
  });

  it('GET /api/admin/nav-counts — a non-admin is refused 403 Forbidden', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden' });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminNavCounts).not.toHaveBeenCalled();
  });

  it('GET /api/admin/nav-counts — an unauthenticated caller is refused 401 Unauthorized', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminNavCounts).not.toHaveBeenCalled();
  });

  it('GET /api/admin/nav-counts — a bearer-transport aal2 admin is served', async () => {
    const response = await GET(bearerRequest());

    expect(response.status).toBe(200);
    // The seam saw the real header, so this is a transport test rather than a
    // second spelling of the cookie case.
    const seen = mockResolveAdminApiIdentity.mock.calls[0]![0] as NextRequest;
    expect(seen.headers.get('authorization')).toBe('Bearer test-admin-access-token');
    // …and the transport the shim RESOLVED from it. Asserting only the header
    // above leaves a hardcoded `transport` in the shim passing every one of the
    // nine bearer cases, which is exactly the mutation this line kills.
    const resolved = await mockResolveAdminApiIdentity.mock.results[0]!.value;
    expect(resolved?.transport).toBe('bearer');
  });
});
