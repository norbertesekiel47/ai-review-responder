import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const { mockRequireRole, mockRequireCurrentAal2FromSupabase, mockSqlReturn } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockRequireCurrentAal2FromSupabase: vi.fn(),
  mockSqlReturn: { value: [] as unknown[] },
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    // #1183: the admin gate maps a resolved identity to its users row instead of
    // calling requireRole. Reuse the outcome resolveDualModeIdentity already
    // produced rather than invoking mockRequireRole a second time — a `...Once`
    // control would be consumed by the seam, and the second call would fall through
    // to the beforeEach default, silently turning a 403 case into a success.
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
    AuthError,
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
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

vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(() => {}, {
    apply: () => Promise.resolve(mockSqlReturn.value),
  }),
  jsonb: (v: unknown) => v,
}));

import { PUT } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

const APP_URL = 'http://localhost:3000';

process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/businesses/biz-1/keywords', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

const makeParams = () => Promise.resolve({ id: 'biz-1' });

// ── Tests ───────────────────────────────────────────────────────────

describe('PUT /api/admin/businesses/[id]/keywords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({ id: 'u1', role: 'admin', accountId: null, locationId: null });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockSqlReturn.value = [{ id: 'biz-1' }];
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await PUT(makeRequest({ keywords: ['pizza'] }), { params: makeParams() });
    expect(res.status).toBe(403);
  });

  it('returns 400 for non-array keywords', async () => {
    const res = await PUT(makeRequest({ keywords: 'not-an-array' }), { params: makeParams() });
    expect(res.status).toBe(400);
  });

  it('returns 400 for more than 5 keywords', async () => {
    const res = await PUT(
      makeRequest({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Maximum 5 keywords');
  });

  it('returns 200 for valid input', async () => {
    const res = await PUT(
      makeRequest({ keywords: ['pizza', 'pasta'] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 200 for empty array (clearing keywords)', async () => {
    const res = await PUT(
      makeRequest({ keywords: [] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 404 when business not found', async () => {
    mockSqlReturn.value = [];
    const res = await PUT(
      makeRequest({ keywords: ['pizza'] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 for whitespace-only keywords', async () => {
    const res = await PUT(
      makeRequest({ keywords: ['   ', '  \t  '] }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });
});
