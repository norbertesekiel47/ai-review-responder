// The admin arm of the Halt latch, at its route boundary (#865; plan §3.3).
//
// Every case loads `../halt/route` through `loadRoute()`, mirroring the
// per-case dynamic import in `api/admin/autonomy/__tests__/routes.test.ts`.
// Two details there are deliberate rather than stylistic, and both exist so a
// route that has not been written yet fails ONE case instead of the whole file:
//
//   - the specifier is a VARIABLE carrying `@vite-ignore`. A literal one —
//     static or dynamic — is resolved by `vite:import-analysis` at TRANSFORM
//     time, so a missing file fails collection and runs zero of the titles.
//   - the module's type comes from `typeof import(…)` in a TYPE position,
//     which is erased before transform. `POST` stays fully typed once Task 2
//     lands, without handing import-analysis a specifier to resolve.
//
// `adminHaltBatch` is mocked, so these cases pin the ROUTE's contract only —
// the gate order, the strict body, and the four status arms. The latch itself
// is proven against live Postgres in
// `src/lib/solicitation/__tests__/approval.integration.test.ts`.

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockAdminHaltBatch,
  mockSql,
  resetMockSql,
} = await vi.hoisted(async () => {
  const helpers = await import('../../../../../../../worker/__tests__/helpers/mock-sql');
  return {
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockAdminHaltBatch: vi.fn(),
    ...helpers.createMockSql(),
  };
});

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
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

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@/lib/solicitation/approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/solicitation/approval')>();
  return { ...actual, adminHaltBatch: mockAdminHaltBatch };
});

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const BUSINESS_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';

const NOTE = 'Owner called support: stop this batch.';

/** Erased before transform — see the header. */
type HaltRouteModule = typeof import('../halt/route');
const HALT_ROUTE = '../halt/route';

async function loadRoute(): Promise<HaltRouteModule> {
  return (await import(/* @vite-ignore */ HALT_ROUTE)) as HaltRouteModule;
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    businessId: BUSINESS_ID,
    batchId: BATCH_ID,
    note: NOTE,
    ...overrides,
  };
}

function postRequest(
  payload: unknown,
  origin = 'https://app.example.com',
): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/solicitation/batch/halt', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(payload),
  });
}

describe('admin solicitation batch halt route', () => {
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
    mockAdminHaltBatch.mockResolvedValue({
      status: 'halted',
      cancelledCount: 2,
      close: { status: 'closed', disposition: 'halted', parentStatus: 'cancelled' },
    });
    delete process.env.SOLICITATION_SEND_ENABLED;
  });

  it('the admin halt route refuses a caller without AAL2 step-up and writes nothing', async () => {
    const { POST } = await loadRoute();
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({
      ok: false,
      reason: 'mfa_required',
    });

    const response = await POST(postRequest(body()));

    // An admin who never stepped up is refused with the SAME shape the rest of
    // the admin control plane uses, and the latch is never reached.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'mfa_required' });
    expect(mockAdminHaltBatch).not.toHaveBeenCalled();
  });

  it('the admin halt route refuses a non-admin caller even with an AAL2 session and writes nothing', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await loadRoute();
    // AAL2 is satisfied on purpose: a stepped-up owner is still not an
    // operator, so the ROLE gate has to refuse independently of the MFA one.
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));

    const response = await POST(postRequest(body()));

    expect(response.status).toBe(403);
    expect(mockAdminHaltBatch).not.toHaveBeenCalled();
  });

  it('the admin halt route rejects reason, haltReason and halt_reason as unknown fields and never calls adminHaltBatch', async () => {
    const { POST } = await loadRoute();

    const responses = await Promise.all([
      POST(postRequest(body({ reason: 'owner_veto' }))),
      POST(postRequest(body({ haltReason: 'owner_halt' }))),
      POST(postRequest(body({ halt_reason: 'admin_halt' }))),
    ]);

    // 400, NOT "ignored" (plan round 1, finding 7). A 200 next to a silently
    // dropped field would let a client believe it chose the halt reason, which
    // is fixed by the route's identity and can never be named by a request.
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(mockAdminHaltBatch).not.toHaveBeenCalled();
  });

  it('the admin halt route rejects a missing, empty or over-long note and writes nothing', async () => {
    const { POST } = await loadRoute();
    const noNote = body();
    delete noNote.note;

    const responses = await Promise.all([
      POST(postRequest(noNote)),
      POST(postRequest(body({ note: '   ' }))),
      POST(postRequest(body({ note: 'x'.repeat(1_001) }))),
    ]);

    // An operator acting on a customer's account says why (D10), and the note
    // is bounded because it lands verbatim in the audit payload.
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(mockAdminHaltBatch).not.toHaveBeenCalled();
  });

  it('the admin halt route rejects a cross-origin POST before calling adminHaltBatch', async () => {
    const { POST } = await loadRoute();

    const response = await POST(postRequest(body(), 'https://evil.example.com'));

    // withSameOrigin wraps the export, so CSRF is refused BEFORE the role gate
    // — `requireRole` is never even consulted.
    expect(response.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockAdminHaltBatch).not.toHaveBeenCalled();
  });

  it('the admin halt route maps halted and already_halted to 200, not_haltable to 409 and not_found to 404', async () => {
    const { POST } = await loadRoute();

    mockAdminHaltBatch.mockResolvedValueOnce({
      status: 'halted',
      cancelledCount: 3,
      close: {
        status: 'closed',
        parentRunId: '55555555-5555-4555-8555-555555555555',
        disposition: 'halted',
        parentStatus: 'cancelled',
        counts: { cancelled: 3 },
      },
    });
    const halted = await POST(postRequest(body()));
    const haltedJson = (await halted.json()) as Record<string, unknown>;

    mockAdminHaltBatch.mockResolvedValueOnce({ status: 'already_halted' });
    const alreadyHalted = await POST(postRequest(body()));

    mockAdminHaltBatch.mockResolvedValueOnce({ status: 'not_haltable', state: 'closed' });
    const notHaltable = await POST(postRequest(body()));

    mockAdminHaltBatch.mockResolvedValueOnce({ status: 'not_found' });
    const notFound = await POST(postRequest(body()));

    expect([halted.status, alreadyHalted.status, notHaltable.status, notFound.status])
      .toEqual([200, 200, 409, 404]);

    // The route passes the body-supplied tenant triple through and stamps the
    // actor from the GATE, never from the request (invariant #8, D1).
    expect(mockAdminHaltBatch).toHaveBeenCalledWith(mockSql, {
      batchId: BATCH_ID,
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
      actorUserId: ADMIN_ID,
      note: NOTE,
    });

    // toWire discipline (owner halt route precedent): the spine vocabulary and
    // the internal run id never reach an admin browser.
    expect(haltedJson).toMatchObject({ status: 'halted', cancelledCount: 3 });
    expect(JSON.stringify(haltedJson)).not.toContain('parentRunId');
    expect(JSON.stringify(haltedJson)).not.toContain('parentStatus');
    expect(JSON.stringify(haltedJson)).not.toContain('disposition');
    expect((await notHaltable.json()) as unknown).toMatchObject({ state: 'closed' });
  });

  it('the admin halt reports closed: false when the close wrote nothing (no_send_parent) — #891', async () => {
    // An all-withheld `built` batch has no send parent and is haltable;
    // `closeBatchIfSettled` writes nothing and answers `no_send_parent`. The
    // old negation proxy (`!== 'not_settled'`) reported that as `closed: true`
    // while `send_closed_at` stayed NULL.
    const { POST } = await loadRoute();

    mockAdminHaltBatch.mockResolvedValueOnce({
      status: 'halted',
      cancelledCount: 1,
      close: { status: 'no_send_parent' },
    });

    const response = await POST(postRequest(body()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'halted',
      closed: false,
    });
  });

  it('the admin halt route has no SOLICITATION_SEND_ENABLED gate — it halts with the send lane flag off', async () => {
    // D5: support must be able to stop a stranded batch AFTER the lane flag is
    // turned off. The flag is a lane switch, not an authorization — asserting
    // this in the domain module would be vacuous, so it is pinned here.
    process.env.SOLICITATION_SEND_ENABLED = 'false';
    const { POST } = await loadRoute();

    const response = await POST(postRequest(body()));

    expect(response.status).toBe(200);
    expect(mockAdminHaltBatch).toHaveBeenCalledTimes(1);
  });
});
