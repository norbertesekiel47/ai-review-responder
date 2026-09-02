// GET /api/dashboard/reviews/pending — the Needs Action queue's read (UX audit D2).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireOwnerWithAccount,
  mockListPendingApprovals,
  mockGetLocationById,
  mockMultiLocationEnabled,
} = vi.hoisted(() => ({
  mockRequireOwnerWithAccount: vi.fn(),
  mockListPendingApprovals: vi.fn(),
  mockGetLocationById: vi.fn(),
  mockMultiLocationEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return { ...actual, requireOwnerWithAccount: mockRequireOwnerWithAccount };
});
vi.mock('@/lib/dashboard/pending-approvals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dashboard/pending-approvals')>();
  return { ...actual, listPendingApprovals: mockListPendingApprovals };
});
vi.mock('@/lib/locations/repo', () => ({ getLocationById: mockGetLocationById }));
vi.mock('@/lib/locations/flags', () => ({ multiLocationEnabled: () => mockMultiLocationEnabled() }));

import { GET } from '../pending/route';

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const LOCATION_ID = 'b0000000-0000-0000-0000-000000000001';
const OTHER_LOCATION_ID = 'b0000000-0000-0000-0000-000000000002';

const PAGE = { items: [], total: 0, pendingTotal: 0, limit: 50, offset: 0 };

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/dashboard/reviews/pending${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMultiLocationEnabled.mockReturnValue(true);
  mockRequireOwnerWithAccount.mockResolvedValue({
    ok: true,
    accountId: ACCOUNT_ID,
    user: { id: 'u-1', accountId: ACCOUNT_ID, locationId: LOCATION_ID },
  });
  mockListPendingApprovals.mockResolvedValue(PAGE);
  mockGetLocationById.mockImplementation(async (_sql: unknown, id: string) => ({
    id,
    account_id: id === OTHER_LOCATION_ID ? 'someone-else' : ACCOUNT_ID,
    archived_at: null,
  }));
});

describe('GET /api/dashboard/reviews/pending', () => {
  it('reads the session location by default with offset 0', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(mockListPendingApprovals).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'location', accountId: ACCOUNT_ID, businessId: LOCATION_ID },
      { offset: 0 },
    );
    expect(await res.json()).toEqual(PAGE);
  });

  it('reads the account scope for ?scope=all and forwards the offset', async () => {
    const res = await GET(request('?scope=all&offset=50'));
    expect(res.status).toBe(200);
    expect(mockListPendingApprovals).toHaveBeenCalledWith(
      expect.anything(),
      { kind: 'account', accountId: ACCOUNT_ID },
      { offset: 50 },
    );
    expect(mockGetLocationById).not.toHaveBeenCalled();
  });

  it('refuses a location that belongs to another account', async () => {
    const res = await GET(request(`?scope=${OTHER_LOCATION_ID}`));
    expect(res.status).toBe(403);
    expect(mockListPendingApprovals).not.toHaveBeenCalled();
  });

  it('rejects a malformed scope before touching the DB', async () => {
    const res = await GET(request('?scope=not-a-uuid'));
    expect(res.status).toBe(400);
    expect(mockGetLocationById).not.toHaveBeenCalled();
  });

  it('clamps a garbage offset to 0', async () => {
    await GET(request('?offset=-9'));
    expect(mockListPendingApprovals).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { offset: 0 },
    );
  });

  it('returns the auth failure untouched', async () => {
    const denied = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    mockRequireOwnerWithAccount.mockResolvedValue({ ok: false, response: denied });
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(mockListPendingApprovals).not.toHaveBeenCalled();
  });
});
