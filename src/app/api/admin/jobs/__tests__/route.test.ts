import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── /api/admin/jobs route — queue-health now fetched from the Railway worker ──
//
// The route no longer touches BullMQ/Redis (invariant #1). It fetches the worker's
// authed /internal/queue-health endpoint server-side and degrades to
// queueHealth:{unavailable:true} on any failure. Outbox + failed-job parts still
// come from Postgres (mocked sql here).

// #1184: this route folded from `requireRoleOr401` onto `requireAdminWithAal2`, so
// the REAL gate runs here and only its dependencies are mocked — through the shared
// shim, the single owner of that mock triple
// (src/lib/auth/__tests__/helpers/admin-gate-mocks.ts). It replaces the old blanket
// `vi.mock('@/lib/auth/route-helpers')` stub, which would have made the new gate
// assertions vacuous.
const {
  mockSql,
  sqlReturnQueue,
  mockGetServerConfig,
  configState,
  mockFetch,
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockLoadAppUser,
  mockResolveDualModeIdentity,
  adminAuthModuleMock,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks, adminAuthModuleMock } =
    await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  const sqlReturnQueue: unknown[] = [];
  const configState: { WORKER_INTERNAL_SECRET?: string; WORKER_PUBLIC_URL?: string } = {};
  return {
    ...makeAdminGateMocks(),
    adminAuthModuleMock,
    sqlReturnQueue,
    configState,
    mockSql: vi.fn((s: TemplateStringsArray, ..._v: unknown[]) => {
      // The service composes an inline fragment (the optional topic predicate,
      // empty when no topic is asked for) into its page + count queries. A
      // fragment is not a round-trip, so it must not consume a seeded result.
      const text = s.join('').trim();
      if (text === '' || text.startsWith('AND jo.topic')) return { fragment: text };
      const r = sqlReturnQueue.shift() ?? [];
      return Promise.resolve(Array.isArray(r) ? r : [r]);
    }),
    mockGetServerConfig: vi.fn(() => configState),
    mockFetch: vi.fn(),
  };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('@/lib/config/server', () => ({ getServerConfig: mockGetServerConfig }));
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

import { GET } from '@/app/api/admin/jobs/route';

const ADMIN = { id: 'admin-1', role: 'admin', accountId: null, locationId: null };

/** Puts a passing aal2 admin behind the gate. */
function seedPassingAdmin(): void {
  mockRequireRole.mockReset();
  mockRequireCurrentAal2FromSupabase.mockReset();
  mockResolveDualModeIdentity.mockClear();
  mockRequireRole.mockResolvedValue(ADMIN);
  mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
}

const SECRET = 'a'.repeat(64);
const WORKER_URL = 'https://worker.example.com';

function seedOutboxRows(): void {
  // Summary, failed page, failed count, distinct failed topics — the four
  // sequential reads getAdminJobsData makes (X15 added the topics read).
  sqlReturnQueue.push(
    [{ pending: 1, dispatching: 0, dispatched: 2, failed: 3, completed_today: 4 }],
    [],
    [{ total: 3 }],
    [],
  );
}

function req(): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/jobs');
}

describe('GET /api/admin/jobs queueHealth sourcing', () => {
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    seedPassingAdmin();
    configState.WORKER_INTERNAL_SECRET = SECRET;
    configState.WORKER_PUBLIC_URL = WORKER_URL;
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('surfaces per-queue depths from the worker on success and preserves outbox shape', async () => {
    const queues = {
      generate_response: { waiting: 2, active: 1, delayed: 0, failed: 0, completed: 9, paused: 0 },
      publish_response: { waiting: 0, active: 0, delayed: 0, failed: 1, completed: 4, paused: 0 },
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ queues }) });
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queueHealth).toEqual(queues);
    expect(body.outbox).toEqual({ pending: 1, dispatching: 0, dispatched: 2, failed: 3, completedToday: 4 });
    expect(body.failedTotal).toBe(3);

    // Bearer secret + correct worker path + short timeout.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0] as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe(`${WORKER_URL}/internal/queue-health`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('degrades to {unavailable:true} when WORKER_INTERNAL_SECRET is unset (no fetch)', async () => {
    configState.WORKER_INTERNAL_SECRET = undefined;
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('degrades to {unavailable:true} when WORKER_PUBLIC_URL is unset (no fetch)', async () => {
    configState.WORKER_PUBLIC_URL = undefined;
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('degrades to {unavailable:true} on a non-200 worker response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
  });

  it('degrades to {unavailable:true} on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
  });

  it('degrades to {unavailable:true} on a fetch timeout (AbortError)', async () => {
    const abort = new DOMException('The operation timed out', 'TimeoutError');
    mockFetch.mockRejectedValue(abort);
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
  });

  it('degrades to {unavailable:true} when the worker response omits queues', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
    expect(body.pool).toBeNull();
  });

  it('surfaces the worker pool-wait sample on success', async () => {
    const queues = {
      generate_response: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, paused: 0 },
    };
    const pool = { waitMs: 42, timedOut: false, saturating: false, max: 12 };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ queues, pool }) });
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual(queues);
    expect(body.pool).toEqual(pool);
  });

  it('passes through pool:null when the worker probe was unavailable (200 with pool:null)', async () => {
    const queues = {
      generate_response: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, paused: 0 },
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ queues, pool: null }) });
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual(queues);
    expect(body.pool).toBeNull();
  });

  it('degrades pool to null alongside queueHealth on a fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    seedOutboxRows();

    const res = await GET(req());
    const body = await res.json();

    expect(body.queueHealth).toEqual({ unavailable: true });
    expect(body.pool).toBeNull();
  });
});

// ── The admin MFA gate on GET (#1184) ───────────────────────────────
//
// The five cases every folded Admin API read owes. Each refusal also asserts the
// no-store header — that is what catches a fold which REWRAPS `gate.response`
// instead of returning it: the status and body would still look right while the
// cache semantics of an admin refusal silently changed.
describe('GET /api/admin/jobs — the admin MFA gate (#1184)', () => {
  beforeEach(() => {
    sqlReturnQueue.length = 0;
    mockSql.mockClear();
    seedPassingAdmin();
    configState.WORKER_INTERNAL_SECRET = undefined;
    configState.WORKER_PUBLIC_URL = undefined;
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('GET /api/admin/jobs — an aal2 admin is served', async () => {
    seedOutboxRows();

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(mockResolveDualModeIdentity).toHaveBeenCalledOnce();
    // The negative half of the bearer case: no Authorization header, so the shim
    // must resolve cookie transport rather than a value it invented.
    const resolved = await mockResolveDualModeIdentity.mock.results[0]!.value;
    expect(resolved?.transport).toBe('cookie');
  });

  it('GET /api/admin/jobs — an aal1 admin is refused 403 mfa_required', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'mfa_required' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('GET /api/admin/jobs — a non-admin is refused 403 Forbidden', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('GET /api/admin/jobs — an unauthenticated caller is refused 401 Unauthorized', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('GET /api/admin/jobs — a bearer-transport aal2 admin is served', async () => {
    seedOutboxRows();
    const bearerReq = new NextRequest('http://localhost:3000/api/admin/jobs', {
      headers: { authorization: 'Bearer test-admin-access-token' },
    });

    const res = await GET(bearerReq);

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
