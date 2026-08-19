import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit suite for the admin send-breaker reset route (#898).
//
// Mirrors src/app/api/admin/autonomy/__tests__/routes.test.ts: the gate is
// mocked at its seam, the shared postgres.js client is the worker mock harness,
// and the route module is imported dynamically inside each case so the mocks
// are in place first.

const { gateMock, resetSendBreakerMock, mockSql, resetMockSql } = await vi.hoisted(async () => {
  const helpers = await import('../../../../../../../worker/__tests__/helpers/mock-sql');
  return {
    gateMock: vi.fn(),
    resetSendBreakerMock: vi.fn(),
    ...helpers.createMockSql(),
  };
});

vi.mock('@/lib/auth/admin-mfa-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/admin-mfa-gate')>();
  return { ...actual, requireAdminWithAal2: gateMock };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

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
    gateMock.mockResolvedValue({
      ok: true,
      admin: {
        id: ADMIN_ID,
        role: 'admin',
        email: 'admin@example.com',
        name: 'Admin',
        accountId: null,
        locationId: null,
      },
    });
    resetSendBreakerMock.mockResolvedValue({ reset: true, tripId: 'trip-1' });
  });

  it('the breaker reset route rejects a request without AAL2', async () => {
    gateMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'aal2_required' }, { status: 403 }),
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
  });

  it('the breaker reset route returns 409 when no trip is open', async () => {
    resetSendBreakerMock.mockResolvedValue({ reset: false, tripId: null });
    const POST = await loadPost();

    const response = await POST(makeRequest({ note: 'nothing to clear' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not_tripped' });
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
