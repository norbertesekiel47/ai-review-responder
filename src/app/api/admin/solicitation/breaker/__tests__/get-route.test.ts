import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit suite for the admin send-breaker READ route (#898).
//
// Same shape as ./reset-route.test.ts: the gate is mocked at its seam, the
// shared postgres.js client is the worker mock harness, and the route module
// is imported dynamically inside each case so the mocks are in place first.
//
// The load-bearing case is the gate. A read route is the easy place to leave a
// weaker door onto the same state — this endpoint returns the platform's send
// health and whether sending is halted, which is exactly what the reset route
// beside it protects with `requireAdminWithAal2`. One audience, one gate.

const { gateMock, readSendBreakerMock, mockSql, resetMockSql } = await vi.hoisted(async () => {
  const helpers = await import('../../../../../../../worker/__tests__/helpers/mock-sql');
  return {
    gateMock: vi.fn(),
    readSendBreakerMock: vi.fn(),
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
  return { ...actual, readSendBreaker: readSendBreakerMock };
});

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TRIPPED_AT = new Date('2026-08-18T09:30:00.000Z');

function makeRequest(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/solicitation/breaker');
}

async function loadGet(): Promise<(request: NextRequest) => Promise<Response>> {
  const route = await import('../route');
  return route.GET;
}

describe('admin send-breaker read route', () => {
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
    readSendBreakerMock.mockResolvedValue({ open: false, trip: null });
  });

  it('the breaker read route rejects a request without AAL2', async () => {
    gateMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'aal2_required' }, { status: 403 }),
    });
    const GET = await loadGet();

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    // The read must not be the weaker door: nothing about the platform's send
    // health is computed, let alone returned, before the gate passes.
    expect(readSendBreakerMock).not.toHaveBeenCalled();
  });

  it('the breaker read route serialises the open trip the way a refetch expects', async () => {
    readSendBreakerMock.mockResolvedValue({
      open: true,
      trip: {
        id: 'trip-1',
        trippedAt: TRIPPED_AT,
        tripReason: 'hard_bounce_rate',
        metrics: {
          sends: 2_000,
          hardBounces: 50,
          complaints: 2,
          hardBounceRate: 0.025,
          complaintRate: 0.001,
        },
      },
    });
    const GET = await loadGet();

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      open: true,
      trip: {
        id: 'trip-1',
        trippedAt: '2026-08-18T09:30:00.000Z',
        tripReason: 'hard_bounce_rate',
        metrics: {
          sends: 2_000,
          hardBounces: 50,
          complaints: 2,
          hardBounceRate: 0.025,
          complaintRate: 0.001,
        },
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store, private');
    expect(readSendBreakerMock).toHaveBeenCalledWith(mockSql);
  });

  it('the breaker read route reports a clear breaker as a null trip', async () => {
    const GET = await loadGet();

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ open: false, trip: null });
  });

  it('the breaker read route maps a failed read to a 500 rather than a halt', async () => {
    // readSendBreaker throws instead of reporting an unknown verdict — on the
    // SEND path that throw IS the halt signal. Here it is only a failed panel
    // load, so it must surface as the standard 500 and nothing more.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    readSendBreakerMock.mockRejectedValue(new Error('connection terminated'));
    const GET = await loadGet();

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });
});
