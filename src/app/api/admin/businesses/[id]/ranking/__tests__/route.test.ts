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

vi.mock('uuid', () => ({
  v7: () => 'mock-uuid-v7',
}));

import { POST } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

const APP_URL = 'http://localhost:3000';

process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/businesses/biz-1/ranking', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

const makeParams = () => Promise.resolve({ id: 'biz-1' });

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/admin/businesses/[id]/ranking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({ id: 'u1', role: 'admin', accountId: null, locationId: null });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockSqlReturn.value = [{ id: 'mock-uuid-v7' }];
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 3 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing keyword', async () => {
    const res = await POST(
      makeRequest({ rankPosition: 3 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for rank_position out of range (0)', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 0 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });

  it('returns 200 for valid input', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 3, date: '2026-04-15' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.id).toBe('mock-uuid-v7');
  });

  it('returns 200 when date is omitted (defaults to today)', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 5 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.id).toBe('mock-uuid-v7');
  });

  it('returns 200 when rankPosition is null', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: null, date: '2026-04-15' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it('returns 400 for invalid calendar date (2026-99-99)', async () => {
    const res = await POST(
      makeRequest({ keyword: 'pizza', rankPosition: 3, date: '2026-99-99' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 for whitespace-only keyword', async () => {
    const res = await POST(
      makeRequest({ keyword: '   ', rankPosition: 3 }),
      { params: makeParams() },
    );
    expect(res.status).toBe(400);
  });
});
