import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockTxCalls,
  mockTxReturns,
  mockInvalidateChannelCache,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockRequireCurrentAal2FromSupabase: vi.fn(),
  mockTxCalls: [] as unknown[][],
  mockTxReturns: [] as unknown[],
  mockInvalidateChannelCache: vi.fn(),
}));

// ── Mock auth ───────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
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

// ── Mock DB ─────────────────────────────────────────────────────────

vi.mock('@/lib/db/server', () => {
  // tx is a callable template-tag AND has .unsafe() method
  function makeTxProxy() {
    const fn = (...args: unknown[]) => {
      mockTxCalls.push(args);
      return Promise.resolve(mockTxReturns.shift() ?? []);
    };
    (fn as unknown as { unsafe: (q: string, v: unknown[]) => Promise<unknown> }).unsafe =
      (q: string, v: unknown[]) => {
        mockTxCalls.push(['UNSAFE', q, v]);
        return Promise.resolve(mockTxReturns.shift() ?? { count: 0 });
      };
    return fn;
  }
  const txProxy = makeTxProxy();
  const sqlProxy = Object.assign(
    (..._args: unknown[]) => Promise.resolve([]),
    {
      begin: async (callback: (tx: unknown) => Promise<void>) => callback(txProxy),
      unsafe: (..._a: unknown[]) => Promise.resolve({ count: 0 }),
    },
  );
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});

vi.mock('@/lib/notifications/resolve-channels', () => ({
  safeInvalidateChannelCache: mockInvalidateChannelCache,
}));

// ── Mock churn-score (imported by route for GET handler) ────────────

vi.mock('@/lib/shared/churn-score', () => ({
  computeChurnRiskScore: () => ({ score: 0, level: 'low', factors: [] }),
}));

// ── Mock uuid (uuidv7 used in INSERT) ───────────────────────────────

vi.mock('uuid', () => ({
  v7: () => '00000000-0000-0000-0000-000000000001',
}));

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

// Import AFTER mocks
import { PATCH } from '../route';

// ── Helpers ─────────────────────────────────────────────────────────

const APP_URL = 'http://localhost';

process.env.NEXT_PUBLIC_APP_URL = APP_URL;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

function makePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/admin/businesses/biz-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', Origin: APP_URL },
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PATCH /api/admin/businesses/[id] — ownerEmail enrollment sync', () => {
  beforeEach(() => {
    mockRequireRole.mockReset();
    mockRequireCurrentAal2FromSupabase.mockReset();
    mockTxCalls.length = 0;
    mockTxReturns.length = 0;
    mockInvalidateChannelCache.mockReset().mockResolvedValue(undefined);
    mockRequireRole.mockResolvedValue({ role: 'admin' });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  });

  it('returns 403 when MFA step-up is not satisfied (AAL2)', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await PATCH(makePatchRequest({ tone: 'formal' }), paramsFor('biz-1'));
    expect(res.status).toBe(403);
  });

  it('PATCH with ownerEmail upserts channel_enrollments inside same txn', async () => {
    // tx calls inside the transaction callback (in order):
    // 1. tx.unsafe (UPDATE businesses) — return { count: 1 }
    // 2. tx`SELECT account_id FROM businesses` — return account_id row
    // 3. tx`INSERT INTO channel_enrollments...` — return []
    mockTxReturns.push({ count: 1 });                // for UPDATE businesses
    mockTxReturns.push([{ account_id: 'acct-1' }]); // for SELECT account_id
    mockTxReturns.push([]);                          // for INSERT channel_enrollments

    const res = await PATCH(
      makePatchRequest({ ownerEmail: 'new@example.com' }),
      paramsFor('biz-1'),
    );
    expect(res.status).toBe(200);

    const enrollmentCall = mockTxCalls.find((args) => {
      // Template-tag call: first arg is TemplateStringsArray
      const t = args[0];
      return Array.isArray(t) && (t as string[]).join('').includes('INSERT INTO channel_enrollments');
    });
    expect(enrollmentCall).toBeDefined();
    expect(mockInvalidateChannelCache).toHaveBeenCalledWith('acct-1', 'admin.business.owner-email');
  });

  it('PATCH with ownerEmail delegates cache invalidation to safe helper', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockTxReturns.push({ count: 1 });
    mockTxReturns.push([{ account_id: 'acct-1' }]);
    mockTxReturns.push([]);

    try {
      const res = await PATCH(
        makePatchRequest({ ownerEmail: 'new@example.com' }),
        paramsFor('biz-1'),
      );

      expect(res.status).toBe(200);
      expect(mockInvalidateChannelCache).toHaveBeenCalledWith('acct-1', 'admin.business.owner-email');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('PATCH without ownerEmail does NOT touch channel_enrollments', async () => {
    mockTxReturns.push({ count: 1 });  // UPDATE businesses

    const res = await PATCH(
      makePatchRequest({ tone: 'formal' }),
      paramsFor('biz-1'),
    );
    expect(res.status).toBe(200);

    const enrollmentCall = mockTxCalls.find((args) => {
      const t = args[0];
      return Array.isArray(t) && (t as string[]).join('').includes('INSERT INTO channel_enrollments');
    });
    expect(enrollmentCall).toBeUndefined();
    expect(mockInvalidateChannelCache).not.toHaveBeenCalled();
  });

  it('PATCH on unknown id returns 404 and rolls back (no enrollment upsert)', async () => {
    mockTxReturns.push({ count: 0 });  // UPDATE businesses — zero rows affected

    const res = await PATCH(
      makePatchRequest({ ownerEmail: 'new@example.com' }),
      paramsFor('missing'),
    );
    expect(res.status).toBe(404);

    const enrollmentCall = mockTxCalls.find((args) => {
      const t = args[0];
      return Array.isArray(t) && (t as string[]).join('').includes('INSERT INTO channel_enrollments');
    });
    expect(enrollmentCall).toBeUndefined();
    expect(mockInvalidateChannelCache).not.toHaveBeenCalled();
  });
});
