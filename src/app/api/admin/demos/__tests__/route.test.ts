import { adminBearerRequest } from '@/lib/auth/__tests__/helpers/admin-gate-mocks';
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
  mockResolveAdminApiIdentity,
  adminAuthModuleMock,
  mockGetAdminDemos,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks, adminAuthModuleMock } =
    await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  return {
    ...makeAdminGateMocks(),
    adminAuthModuleMock,
    mockGetAdminDemos: vi.fn(),
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

vi.mock('@/lib/admin/demos-service', () => ({
  getAdminDemos: (...args: unknown[]) => mockGetAdminDemos(...args),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError: vi.fn() }));

// ── Helpers ─────────────────────────────────────────────────────────

const ADMIN = { id: 'admin-1', role: 'admin', accountId: null, locationId: null };

const DEMOS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    demoUrlSlug: 'acme-dental',
    businessName: 'Acme Dental',
    generationStatus: 'ready',
    generationError: null,
    viewCount: 4,
    generatedAt: '2026-06-01T12:00:00.000Z',
    expiresAt: '2026-07-01T12:00:00.000Z',
  },
];

function makeRequest(): NextRequest {
  return adminBearerRequest('http://localhost:3000/api/admin/demos');
}

function bearerRequest(): NextRequest {
  return adminBearerRequest('http://localhost:3000/api/admin/demos', {
    headers: { authorization: 'Bearer test-admin-access-token' },
  });
}

// ── Tests ───────────────────────────────────────────────────────────
//
// Each refusal also asserts the no-store header. That is what catches a fold that
// REWRAPS `gate.response` instead of returning it — the status and the body would
// still look right while the cache semantics of an admin refusal silently changed.
describe('GET /api/admin/demos — the admin MFA gate (#1184)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ADMIN);
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockGetAdminDemos.mockResolvedValue(DEMOS);
  });

  it('GET /api/admin/demos — an aal2 admin is served', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockResolveAdminApiIdentity).toHaveBeenCalledOnce();
    // The route fixture supplies a bearer; ordinary Admin APIs no longer accept cookies.
    const resolved = await mockResolveAdminApiIdentity.mock.results[0]!.value;
    expect(resolved?.transport).toBe('bearer');
  });

  it('returns the service result unchanged', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEMOS);
    expect(mockGetAdminDemos).toHaveBeenCalledOnce();
  });

  it('GET /api/admin/demos — an aal1 admin is refused 403 mfa_required', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminDemos).not.toHaveBeenCalled();
  });

  it('GET /api/admin/demos — a non-admin is refused 403 Forbidden', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminDemos).not.toHaveBeenCalled();
  });

  it('GET /api/admin/demos — an unauthenticated caller is refused 401 Unauthorized', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));
    const { GET } = await import('../route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetAdminDemos).not.toHaveBeenCalled();
  });

  it('GET /api/admin/demos — a bearer-transport aal2 admin is served', async () => {
    const { GET } = await import('../route');
    const res = await GET(bearerRequest());

    expect(res.status).toBe(200);
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
