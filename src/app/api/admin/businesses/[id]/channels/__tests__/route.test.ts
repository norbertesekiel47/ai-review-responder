// src/app/api/admin/businesses/[id]/channels/__tests__/route.test.ts
//
// Follows the mock-based pattern in src/lib/notifications/__tests__/enrollments.test.ts
// — hoists the sql mock so the module import in the route sees it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// #1184: this route folded from `requireRoleOr401` onto `requireAdminWithAal2`, so
// the REAL gate runs here and only its dependencies are mocked — through the shared
// shim, the single owner of that mock triple
// (src/lib/auth/__tests__/helpers/admin-gate-mocks.ts). It replaces the old
// `requireRole: vi.fn().mockResolvedValue(undefined)` stub, which would have made the
// new gate assertions vacuous.
const {
  sqlReturnQueue,
  mockSql,
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockLoadAppUser,
  mockResolveDualModeIdentity,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks } = await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });
  return { sqlReturnQueue, mockSql, ...makeAdminGateMocks() };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

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

import { GET } from '../route';

// The shim reads mockRequireRole's RESOLVED value as the app user, so a live admin
// must be a real object — `undefined` would make loadAppUser report a falsy user and
// the gate would answer 403.
const ADMIN = { id: 'admin-1', role: 'admin', accountId: null, locationId: null };

/** Puts a passing aal2 admin behind the gate. */
function seedPassingAdmin(): void {
  mockRequireRole.mockReset();
  mockRequireCurrentAal2FromSupabase.mockReset();
  mockResolveDualModeIdentity.mockClear();
  mockRequireRole.mockResolvedValue(ADMIN);
  mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
}

const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000ac';
const L1 = '00000000-0000-0000-0000-0000000000a1';
const L2 = '00000000-0000-0000-0000-0000000000a2';

/** Returns the joined query text for the Nth sql call (0-indexed). */
function queryText(callIndex: number): string {
  const [template] = mockSql.mock.calls[callIndex] as [TemplateStringsArray, ...unknown[]];
  return template.join('?');
}

describe('GET /api/admin/businesses/[id]/channels — archived rows', () => {
  beforeEach(() => {
    mockSql.mockClear();
    sqlReturnQueue.length = 0;
    seedPassingAdmin();
  });

  it('filters query by archived_at IS NULL (query shape assertion)', async () => {
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]); // account resolution
    sqlReturnQueue.push([]); // no enrollments
    const req = new NextRequest('http://localhost/api/admin/businesses/biz-1/channels');
    await GET(req, { params: Promise.resolve({ id: 'biz-1' }) });

    // The enrollment query is the LAST sql call.
    const enrollmentQuery = queryText(mockSql.mock.calls.length - 1);
    expect(enrollmentQuery).toMatch(/channel_enrollments/);
    expect(enrollmentQuery).toMatch(/e\.archived_at IS NULL/);
  });
});

describe('GET /api/admin/businesses/[id]/channels — account-scoped org-default', () => {
  beforeEach(() => {
    mockSql.mockClear();
    sqlReturnQueue.length = 0;
    seedPassingAdmin();
  });

  it('keys the enrollment read by account_id with org-default + per-location predicate', async () => {
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]); // account resolution
    sqlReturnQueue.push([]); // enrollments

    const req = new NextRequest(`http://localhost/api/admin/businesses/${L2}/channels`);
    await GET(req, { params: Promise.resolve({ id: L2 }) });

    const enrollmentQuery = queryText(mockSql.mock.calls.length - 1);
    expect(enrollmentQuery).toMatch(/account_id\s*=/);
    expect(enrollmentQuery).toMatch(/location_id\s*=/);
    expect(enrollmentQuery).toMatch(/location_id IS NULL/);
    // last_activity_at scopes deliveries to the VIEWED location (route
    // businessId), not the enrollment row's legacy business_id — otherwise an
    // org-default row would surface the creator location's activity on this page.
    expect(enrollmentQuery).toMatch(/nd\.business_id = \?/);
    expect(enrollmentQuery).not.toMatch(/nd\.business_id = e\.business_id/);
  });

  it('surfaces an org-default row created under L1 when viewing L2 detail', async () => {
    // Org-default row was created under location L1 (location_id IS NULL,
    // account-scoped). Viewing L2's detail page must still surface it — admin
    // start/disable act on this exact row regardless of which location is open.
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]); // account resolution
    sqlReturnQueue.push([
      {
        channel: 'telegram',
        handle: '123456789',
        status: 'verified',
        verified_at: new Date('2026-01-01T00:00:00Z'),
        disabled_at: null,
        unsubscribed_at: null,
        unsubscribed_reason: null,
        expires_at: null,
        last_activity_at: null,
        location_id: null, // org-default
      },
    ]);

    const req = new NextRequest(`http://localhost/api/admin/businesses/${L2}/channels`);
    const res = await GET(req, { params: Promise.resolve({ id: L2 }) });
    const body = (await res.json()) as {
      enrollments: Array<{ channel: string; status: string }>;
    };

    expect(body.enrollments).toHaveLength(1);
    const [enrollment] = body.enrollments;
    expect(enrollment).toBeDefined();
    expect(enrollment?.channel).toBe('telegram');
    expect(enrollment?.status).toBe('verified');
  });

  it('prefers a per-location L2 override over the org-default for the same channel', async () => {
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]); // account resolution
    // Both rows exist for the SAME channel: org-default (NULL) + L2 override.
    // The route's ORDER BY places overrides first, so the override row arrives
    // first in this mocked result set.
    sqlReturnQueue.push([
      {
        channel: 'telegram',
        handle: '111111111',
        status: 'verified',
        verified_at: new Date('2026-01-01T00:00:00Z'),
        disabled_at: null,
        unsubscribed_at: null,
        unsubscribed_reason: null,
        expires_at: null,
        last_activity_at: null,
        location_id: L2, // per-location override — must win
      },
      {
        channel: 'telegram',
        handle: '999999999',
        status: 'verified',
        verified_at: new Date('2025-12-01T00:00:00Z'),
        disabled_at: null,
        unsubscribed_at: null,
        unsubscribed_reason: null,
        expires_at: null,
        last_activity_at: null,
        location_id: null, // org-default — must lose
      },
    ]);

    const req = new NextRequest(`http://localhost/api/admin/businesses/${L2}/channels`);
    const res = await GET(req, { params: Promise.resolve({ id: L2 }) });
    const body = (await res.json()) as {
      enrollments: Array<{ channel: string; handle: string }>;
    };

    // One effective enrollment per channel, and it's the per-location override.
    expect(body.enrollments).toHaveLength(1);
    const [enrollment] = body.enrollments;
    expect(enrollment).toBeDefined();
    expect(enrollment?.channel).toBe('telegram');
    // telegram handle is masked to last 4 digits: 111111111 -> '••• 1111'
    expect(enrollment?.handle).toBe('••• 1111');
  });

  it('returns empty enrollments and skips the enrollment query when the location is unknown', async () => {
    sqlReturnQueue.push([]); // account resolution: no row

    const req = new NextRequest(`http://localhost/api/admin/businesses/${L1}/channels`);
    const res = await GET(req, { params: Promise.resolve({ id: L1 }) });
    const body = (await res.json()) as { enrollments: unknown[] };

    expect(body.enrollments).toEqual([]);
    // Only the account-resolution query ran.
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

// ── The admin MFA gate on GET (#1184) ───────────────────────────────
//
// The five cases every folded Admin API read owes, plus the one this route owes
// alone: it had NO try/catch at all, so the gate's `internal_error` arm is new
// behaviour here. Each refusal also asserts the no-store header — that is what
// catches a fold which REWRAPS `gate.response` instead of returning it.
describe('GET /api/admin/businesses/[id]/channels — the admin MFA gate (#1184)', () => {
  beforeEach(() => {
    mockSql.mockClear();
    sqlReturnQueue.length = 0;
    seedPassingAdmin();
  });

  function makeGetRequest(): NextRequest {
    return new NextRequest(`http://localhost/api/admin/businesses/${L1}/channels`);
  }

  function paramsFor(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it('GET /api/admin/businesses/[id]/channels — an aal2 admin is served', async () => {
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]);
    sqlReturnQueue.push([]);

    const res = await GET(makeGetRequest(), paramsFor(L1));

    expect(res.status).toBe(200);
    expect(mockResolveDualModeIdentity).toHaveBeenCalledOnce();
  });

  it('GET /api/admin/businesses/[id]/channels — an aal1 admin is refused 403 mfa_required', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    const res = await GET(makeGetRequest(), paramsFor(L1));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('GET /api/admin/businesses/[id]/channels — a non-admin is refused 403 Forbidden', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const res = await GET(makeGetRequest(), paramsFor(L1));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('GET /api/admin/businesses/[id]/channels — an unauthenticated caller is refused 401 Unauthorized', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));

    const res = await GET(makeGetRequest(), paramsFor(L1));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('GET /api/admin/businesses/[id]/channels — a bearer-transport aal2 admin is served', async () => {
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]);
    sqlReturnQueue.push([]);
    const req = new NextRequest(`http://localhost/api/admin/businesses/${L1}/channels`, {
      headers: { authorization: 'Bearer test-admin-access-token' },
    });

    const res = await GET(req, paramsFor(L1));

    expect(res.status).toBe(200);
    // The seam saw the real header, so this is a transport test rather than a
    // second spelling of the cookie case.
    const seen = mockResolveDualModeIdentity.mock.calls[0]![0] as NextRequest;
    expect(seen.headers.get('authorization')).toBe('Bearer test-admin-access-token');
  });

  it('GET /api/admin/businesses/[id]/channels — a non-AuthError gate failure is internal_error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockRequireRole.mockRejectedValue(new Error('supabase unreachable'));

    const res = await GET(makeGetRequest(), paramsFor(L1));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockSql).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
