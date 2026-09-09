import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit suite for the admin send-breaker reset route (#898).
//
// Mirrors src/app/api/admin/autonomy/__tests__/routes.test.ts, and mirrors it at
// the level that file actually uses: the auth PRIMITIVES are mocked
// (requireRole + the AAL2 lookup), never `requireAdminJson` itself. That matters
// because the route's 400 shapes — `invalid_body` and the first schema issue —
// live inside the shared gate helper now. Stubbing the helper would leave the
// blank-note and body-actor cases asserting a mock instead of the shipped code,
// which is the whole thing those cases exist to pin.
//
// The shared postgres.js client is the worker mock harness, and the route module
// is imported dynamically inside each case so the mocks are in place first.

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockLoadAppUser,
  mockResolveDualModeIdentity,
  resetSendBreakerMock,
  loggerMock,
  mockSql,
  resetMockSql,
} = await vi.hoisted(async () => {
  const { makeAdminGateMocks } = await import('@/lib/auth/__tests__/helpers/admin-gate-mocks');
  const helpers = await import('../../../../../../../worker/__tests__/helpers/mock-sql');
  return {
    ...makeAdminGateMocks(),
    resetSendBreakerMock: vi.fn(),
    loggerMock: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...helpers.createMockSql(),
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  loadAppUser: mockLoadAppUser,
  cookieBackedServerClient: () => ({ auth: { mfa: {} } }),
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));

// #1184: the gate's dependency stand-ins have one owner —
// src/lib/auth/__tests__/helpers/admin-gate-mocks.ts.
vi.mock('@/lib/auth/verified-identity', () => ({
  resolveDualModeIdentity: mockResolveDualModeIdentity,
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@/lib/shared/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/logger')>();
  return { ...actual, createWorkerLogger: () => loggerMock };
});

vi.mock('@/lib/solicitation/send-breaker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solicitation/send-breaker')>();
  return { ...actual, resetSendBreaker: resetSendBreakerMock };
});

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';

function makeRequest(body: unknown, origin = 'https://app.example.com'): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/solicitation/breaker/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

async function loadPost(): Promise<(request: NextRequest) => Promise<Response>> {
  const route = await import('../reset/route');
  return route.POST;
}

describe('admin send-breaker reset route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID,
      role: 'admin',
      email: 'admin@example.com',
      name: 'Admin',
      accountId: null,
      locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    resetSendBreakerMock.mockResolvedValue({ reset: true, tripId: 'trip-1' });
  });

  it('the breaker reset route rejects a request without AAL2', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({
      ok: false,
      reason: 'mfa_required',
    });
    const POST = await loadPost();

    expect((await POST(makeRequest({ note: 'x' }))).status).toBe(403);
    expect(resetSendBreakerMock).not.toHaveBeenCalled();
  });

  it('the breaker reset route fixes the actor from the session and ignores any actor in the body', async () => {
    // Same discipline adminHaltBatch applies to its reason: identity comes from
    // the gate, never from the request. A body-supplied actor must not merely be
    // overridden — strictObject REJECTS it, so a caller cannot believe it worked.
    const POST = await loadPost();

    const response = await POST(
      makeRequest({ note: 'ramp rolled back', actorUserId: OTHER_USER_ID }),
    );

    expect(response.status).toBe(400);
    expect(resetSendBreakerMock).not.toHaveBeenCalled();

    // The FIXES half, which rejection alone does not prove: an implementation
    // passing '', a hard-coded uuid, or parsed.data's absent field would satisfy
    // every rejection case above while violating invariant #8. Assert the actor
    // the module actually receives, on a body the schema accepts.
    const accepted = await POST(makeRequest({ note: 'ramp rolled back' }));

    expect(accepted.status).toBe(200);
    expect(resetSendBreakerMock).toHaveBeenCalledWith(expect.anything(), {
      actorUserId: ADMIN_ID,
      note: 'ramp rolled back',
    });
  });

  it('the breaker reset route returns 409 when no trip is open', async () => {
    resetSendBreakerMock.mockResolvedValue({ reset: false, tripId: null });
    const POST = await loadPost();

    const response = await POST(makeRequest({ note: 'nothing to clear' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not_tripped' });
  });

  // The intake's promised admin-reset observability line (round-2 R2-3). The
  // durable `solicitation_send_breaker` row is the audit record, but nothing
  // joined the reset to a request in the log stream, so a post-incident review
  // could not place it next to whatever else that admin did in the same window.
  it('the breaker reset route logs the actor and the trip id, and never the note text', async () => {
    const POST = await loadPost();

    const response = await POST(makeRequest({ note: 'suppressed the 2026-08-14 import' }));

    expect(response.status).toBe(200);
    expect(loggerMock.log).toHaveBeenCalledWith('admin_send_breaker_reset', {
      reset: true,
      tripId: 'trip-1',
      actorUserId: ADMIN_ID,
      hasNote: true,
    });

    // PRESENCE, never content: the note is free text an operator typed, and its
    // durable home is the access-controlled row, not a log sink. Assert against
    // the whole serialized call so a future field carrying it fails here.
    expect(JSON.stringify(loggerMock.log.mock.calls)).not.toContain('suppressed the');
  });

  it('the breaker reset route logs the no-op arm with a null trip id', async () => {
    // A double-submit is legible in the stream too — `tripId` is null exactly
    // when nothing was open, which is what distinguishes it from a real reset.
    resetSendBreakerMock.mockResolvedValue({ reset: false, tripId: null });
    const POST = await loadPost();

    expect((await POST(makeRequest({ note: 'nothing to clear' }))).status).toBe(409);
    expect(loggerMock.log).toHaveBeenCalledWith('admin_send_breaker_reset', {
      reset: false,
      tripId: null,
      actorUserId: ADMIN_ID,
      hasNote: true,
    });
  });

  it('the breaker reset route requires a non-empty note', async () => {
    // 110's reset_consistency CHECK rejects a reset without a note, so the
    // route must reject a blank one rather than letting a 23514 surface as 500.
    const POST = await loadPost();

    for (const note of ['', '   ']) {
      expect((await POST(makeRequest({ note }))).status).toBe(400);
    }
    expect(resetSendBreakerMock).not.toHaveBeenCalled();
  });
});
