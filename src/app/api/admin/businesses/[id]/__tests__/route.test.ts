import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

// #1184: GET folded from `requireRoleOr401` onto `requireAdminWithAal2`, so the REAL
// gate runs here for BOTH verbs and only its dependencies are mocked — through the
// shared shim, the single owner of that mock triple
// (src/lib/auth/__tests__/helpers/admin-gate-mocks.ts). It replaces the inline #1183
// copy this suite used to carry. `mockRequireRole` still says whether there is a live
// admin and `mockRequireCurrentAal2FromSupabase` still says whether the AAL2 step-up
// passed, so every pre-existing assertion below keeps its meaning.
const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockLoadAppUser,
  mockResolveDualModeIdentity,
  adminAuthModuleMock,
  mockTxCalls,
  mockTxReturns,
  mockInvalidateChannelCache,
  mockGetBusinessDetail,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks, adminAuthModuleMock } =
    await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  return {
    ...makeAdminGateMocks(),
    adminAuthModuleMock,
    mockTxCalls: [] as unknown[][],
    mockTxReturns: [] as unknown[],
    mockInvalidateChannelCache: vi.fn(),
    // GET delegates the whole read to the detail service, which has its own suite.
    // Only `getBusinessDetail` is stubbed — PATCH still runs the REAL `updateBusiness`
    // + `FIELD_TO_COLUMN`, which the tx-shape assertions below depend on.
    mockGetBusinessDetail: vi.fn(),
  };
});

// ── Mock auth ───────────────────────────────────────────────────────

vi.mock('@/lib/db/auth', () => adminAuthModuleMock(mockRequireRole, mockLoadAppUser));

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

vi.mock('@/lib/auth/verified-identity', () => ({
  resolveDualModeIdentity: mockResolveDualModeIdentity,
}));

// Only the GET read is stubbed; PATCH's `updateBusiness` + `FIELD_TO_COLUMN` stay REAL.
vi.mock('@/lib/admin/business-detail-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/business-detail-service')>();
  return { ...actual, getBusinessDetail: mockGetBusinessDetail };
});

// Import AFTER mocks
import { GET, PATCH } from '../route';

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

// ── The admin MFA gate on GET (#1184) ───────────────────────────────
//
// The five cases every folded Admin API read owes. Each refusal also asserts the
// no-store header — that is what catches a fold which REWRAPS `gate.response`
// instead of returning it: the status and body would still look right while the
// cache semantics of an admin refusal silently changed.
describe('GET /api/admin/businesses/[id] — the admin MFA gate (#1184)', () => {
  const ADMIN = { id: 'admin-1', role: 'admin', accountId: null, locationId: null };
  const DETAIL = { business: { id: 'biz-1', name: 'Test Cafe' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ADMIN);
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockGetBusinessDetail.mockResolvedValue(DETAIL);
  });

  function makeGetRequest(): NextRequest {
    return new NextRequest('http://localhost/api/admin/businesses/biz-1');
  }

  it('GET /api/admin/businesses/[id] — an aal2 admin is served', async () => {
    const res = await GET(makeGetRequest(), paramsFor('biz-1'));

    expect(res.status).toBe(200);
    expect(mockResolveDualModeIdentity).toHaveBeenCalledOnce();
    // The negative half of the bearer case: no Authorization header, so the shim
    // must resolve cookie transport rather than a value it invented.
    const resolved = await mockResolveDualModeIdentity.mock.results[0]!.value;
    expect(resolved?.transport).toBe('cookie');
  });

  it('GET /api/admin/businesses/[id] — an aal1 admin is refused 403 mfa_required', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    const res = await GET(makeGetRequest(), paramsFor('biz-1'));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetBusinessDetail).not.toHaveBeenCalled();
  });

  it('GET /api/admin/businesses/[id] — a non-admin is refused 403 Forbidden', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const res = await GET(makeGetRequest(), paramsFor('biz-1'));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetBusinessDetail).not.toHaveBeenCalled();
  });

  it('GET /api/admin/businesses/[id] — an unauthenticated caller is refused 401 Unauthorized', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));

    const res = await GET(makeGetRequest(), paramsFor('biz-1'));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetBusinessDetail).not.toHaveBeenCalled();
  });

  it('GET /api/admin/businesses/[id] — a bearer-transport aal2 admin is served', async () => {
    const req = new NextRequest('http://localhost/api/admin/businesses/biz-1', {
      headers: { authorization: 'Bearer test-admin-access-token' },
    });

    const res = await GET(req, paramsFor('biz-1'));

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
