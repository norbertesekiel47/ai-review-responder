// The owner read route (#632 Task 6): a thin adapter — flag gate, owner auth,
// location scope, one module call (invariant #12).
//
// The flag is checked BEFORE auth so an unauthenticated probe cannot use the
// route's response shape to learn whether the send surface exists, and the send
// state is PASSED to the read model rather than read inside it (flags stay
// server-authoritative, invariant #13).
//
// Mock shape follows the batch route's suite: the location repo and the
// multi-location flag are stubbed so the scope policy resolves without a
// database, and the read model is stubbed so this file tests the ADAPTER only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireOwnerWithAccount,
  mockGetLocationById,
  mockMultiLocationEnabled,
  mockListAttributedReviews,
} = vi.hoisted(() => ({
  mockRequireOwnerWithAccount: vi.fn(),
  mockGetLocationById: vi.fn(),
  mockMultiLocationEnabled: vi.fn(() => false),
  mockListAttributedReviews: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

vi.mock('@/lib/auth/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/route-helpers')>();
  return {
    ...actual,
    requireOwnerWithAccount: (...args: unknown[]) => mockRequireOwnerWithAccount(...args),
  };
});

vi.mock('@/lib/locations/repo', () => ({
  getLocationById: (...args: unknown[]) => mockGetLocationById(...args),
}));

vi.mock('@/lib/locations/flags', () => ({
  multiLocationEnabled: () => mockMultiLocationEnabled(),
}));

vi.mock('@/lib/solicitation/attribution', () => ({
  listAttributedReviews: (...args: unknown[]) => mockListAttributedReviews(...args),
}));

import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import { GET } from '../route';

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const DEFAULT_LOCATION_ID = '01900000-0000-7000-8000-0000000000d1';
const OTHER_LOCATION_ID = '01900000-0000-7000-8000-0000000000d2';

const BASE_URL = 'http://localhost:3000/api/dashboard/solicitation/attributed';

const MATCH = {
  outreachId: '01900000-0000-7000-8000-00000000000a',
  reviewId: '01900000-0000-7000-8000-00000000000b',
  reviewerName: 'Dana Rodriguez',
  starRating: 5,
  reviewDate: '2026-08-20 09:00:00+00',
  askSentAt: '2026-08-14 09:00:00+00',
  attributedAt: '2026-08-20 09:05:00+00',
  rule: 'full_name',
};

function getRequest(query = ''): NextRequest {
  return new NextRequest(`${BASE_URL}${query}`);
}

beforeEach(() => {
  vi.stubEnv('SOLICITATION_WATCH_ENABLED', 'true');
  mockRequireOwnerWithAccount.mockResolvedValue({
    ok: true,
    accountId: ACCOUNT_ID,
    user: { id: 'u-1', locationId: DEFAULT_LOCATION_ID },
  });
  mockMultiLocationEnabled.mockReturnValue(false);
  mockGetLocationById.mockImplementation((_sql: unknown, locationId: string) =>
    Promise.resolve({ id: locationId, account_id: ACCOUNT_ID, archived_at: null }),
  );
  mockListAttributedReviews.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('GET attributed', () => {
  it('GET attributed: gates on the flag before auth and passes account, location scope and send state to the read model', async () => {
    // 1. Watch-mode off: the surface does not exist. A 404 status alone does
    //    not prove gate ORDER, so the assertion is that no auth work and no
    //    read happened at all (invariant #13).
    vi.stubEnv('SOLICITATION_WATCH_ENABLED', undefined);
    const gated = await GET(getRequest());
    expect(gated.status).toBe(404);
    await expect(gated.json()).resolves.toEqual({ error: 'Not found' });
    expect(mockRequireOwnerWithAccount).not.toHaveBeenCalled();
    expect(mockListAttributedReviews).not.toHaveBeenCalled();

    // 2. Watch-mode on, send flag unset: the route reads the flag itself and
    //    passes it through as false rather than letting the read model decide,
    //    and the browser learns that state from `enabled` in the body.
    vi.stubEnv('SOLICITATION_WATCH_ENABLED', 'true');
    const off = await GET(getRequest(withSolicitationScope('', OTHER_LOCATION_ID)));
    expect(off.status).toBe(200);
    expect(mockRequireOwnerWithAccount).toHaveBeenCalledTimes(1);
    // The LOCATION comes from the scope param, never the owner default — a
    // route that dropped it would silently read a different location.
    expect(mockListAttributedReviews).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      businessId: OTHER_LOCATION_ID,
      sendEnabled: false,
    });
    await expect(off.json()).resolves.toEqual({ enabled: false, attributed: [] });

    // 3. Send flag on: the same value reaches the read model and the body, and
    //    the module's rows are returned untouched.
    vi.stubEnv('SOLICITATION_SEND_ENABLED', 'true');
    mockListAttributedReviews.mockResolvedValue([MATCH]);
    const on = await GET(getRequest());
    expect(on.status).toBe(200);
    expect(mockListAttributedReviews).toHaveBeenLastCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      businessId: DEFAULT_LOCATION_ID,
      sendEnabled: true,
    });
    await expect(on.json()).resolves.toEqual({ enabled: true, attributed: [MATCH] });
  });
});
