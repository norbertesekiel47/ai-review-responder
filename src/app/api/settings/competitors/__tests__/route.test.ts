import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  mockRequireRole,
  mockLoadRivalPickerView,
  mockSetNamedRivalPick,
  mockGetOffboardingState,
  mockEnqueueAnalyticsEvent,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockLoadRivalPickerView: vi.fn(),
  mockSetNamedRivalPick: vi.fn(),
  mockGetOffboardingState: vi.fn(),
  mockEnqueueAnalyticsEvent: vi.fn(),
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
    AuthError,
  };
});

// The module's real error classes are re-exported so the route's
// `instanceof` mapping is exercised against the same constructors the
// production module throws.
vi.mock('@/lib/competitors/named-rival', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/competitors/named-rival')>();
  return {
    ...actual,
    loadRivalPickerView: (...args: unknown[]) => mockLoadRivalPickerView(...args),
    setNamedRivalPick: (...args: unknown[]) => mockSetNamedRivalPick(...args),
  };
});

// The durable analytics write belongs to the module, not the route. Spying on
// it proves the route never emits an engagement event for a rejected request.
vi.mock('@/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: (...args: unknown[]) => mockEnqueueAnalyticsEvent(...args),
}));

vi.mock('@/lib/account-offboarding/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/account-offboarding/gate')>();
  return {
    ...actual,
    getOffboardingState: (...args: unknown[]) => mockGetOffboardingState(...args),
  };
});

import { RivalPickNotFoundError, RivalPickStaleError } from '@/lib/competitors/named-rival';
import { GET, PUT } from '../route';

const APP_URL = 'http://localhost:3000';
const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID = '11111111-0000-0000-0000-000000000001';
const BUSINESS_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const PLACE_ID = 'ChIJ-bravo-beans';

function ownerUser() {
  return {
    id: USER_ID,
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: BUSINESS_ID,
  };
}

function readyView() {
  return {
    state: 'ready' as const,
    businessId: BUSINESS_ID,
    keyword: 'coffee shop',
    options: [
      { placeId: PLACE_ID, title: 'Bravo Beans', rankPosition: 4, reviewCount: 150, rating: 4.4 },
    ],
    pick: null,
  };
}

function makeRequest(
  method: 'GET' | 'PUT',
  body?: unknown,
  opts: { origin?: string | null; url?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const origin = opts.origin === undefined ? APP_URL : opts.origin;
  if (origin !== null) headers.Origin = origin;

  return new NextRequest(
    opts.url ?? `${APP_URL}/api/settings/competitors?businessId=${BUSINESS_ID}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

describe('/api/settings/competitors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    mockRequireRole.mockResolvedValue(ownerUser());
    mockGetOffboardingState.mockResolvedValue(null);
    mockLoadRivalPickerView.mockResolvedValue(readyView());
    mockSetNamedRivalPick.mockResolvedValue(readyView());
  });

  it('returns 404 and writes no analytics event for a businessId outside the caller’s account', async () => {
    mockLoadRivalPickerView.mockRejectedValueOnce(new RivalPickNotFoundError(BUSINESS_ID));

    const res = await GET(makeRequest('GET'));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('returns 404 on PUT for a businessId outside the caller’s account', async () => {
    mockSetNamedRivalPick.mockRejectedValueOnce(new RivalPickNotFoundError(BUSINESS_ID));

    const res = await PUT(makeRequest('PUT', { businessId: BUSINESS_ID, placeId: PLACE_ID }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('rejects a pick whose place_id is absent from the latest pack with 409 pack_refreshed', async () => {
    mockSetNamedRivalPick.mockRejectedValueOnce(new RivalPickStaleError(PLACE_ID));

    const res = await PUT(makeRequest('PUT', { businessId: BUSINESS_ID, placeId: PLACE_ID }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'pack_refreshed' });
    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('rejects a request that supplies a title alongside the place id', async () => {
    const res = await PUT(makeRequest('PUT', {
      businessId: BUSINESS_ID,
      placeId: PLACE_ID,
      title: 'Attacker Renamed Rival',
    }));

    expect(res.status).toBe(400);
    expect(mockSetNamedRivalPick).not.toHaveBeenCalled();
  });

  it('returns the picker view for the caller’s own location', async () => {
    const res = await GET(makeRequest('GET'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(await res.json()).toEqual(readyView());
    expect(mockLoadRivalPickerView).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
    });
  });

  it.each([
    ['missing', `${APP_URL}/api/settings/competitors`],
    ['malformed', `${APP_URL}/api/settings/competitors?businessId=not-a-uuid`],
  ])('GET requires a well-formed businessId search param (%s)', async (_label, url) => {
    const res = await GET(makeRequest('GET', undefined, { url }));

    expect(res.status).toBe(400);
    expect(mockLoadRivalPickerView).not.toHaveBeenCalled();
  });

  it('rejects accountId in the GET query', async () => {
    const res = await GET(makeRequest('GET', undefined, {
      url: `${APP_URL}/api/settings/competitors?businessId=${BUSINESS_ID}&accountId=attacker`,
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'account_id_not_allowed' });
    expect(mockLoadRivalPickerView).not.toHaveBeenCalled();
  });

  it('PUT rejects a missing Origin before auth', async () => {
    const res = await PUT(makeRequest('PUT', { businessId: BUSINESS_ID, placeId: null }, {
      origin: null,
    }));

    expect(res.status).toBe(403);
    expect(mockRequireRole).not.toHaveBeenCalled();
    expect(mockSetNamedRivalPick).not.toHaveBeenCalled();
  });

  it('PUT forwards a clear (placeId null) with the acting owner user id', async () => {
    const res = await PUT(makeRequest('PUT', { businessId: BUSINESS_ID, placeId: null }));

    expect(res.status).toBe(200);
    expect(mockSetNamedRivalPick).toHaveBeenCalledWith(expect.anything(), {
      accountId: ACCOUNT_ID,
      businessId: BUSINESS_ID,
      placeId: null,
      userId: USER_ID,
    });
  });

  it.each([
    { businessId: 'not-a-uuid', placeId: PLACE_ID },
    { businessId: BUSINESS_ID },
    { businessId: BUSINESS_ID, placeId: '' },
    { businessId: BUSINESS_ID, placeId: 'x'.repeat(256) },
    { businessId: BUSINESS_ID, placeId: 42 },
    { placeId: PLACE_ID },
    { businessId: BUSINESS_ID, placeId: PLACE_ID, accountId: 'attacker' },
  ])('PUT rejects a malformed body with 400: %o', async (body) => {
    const res = await PUT(makeRequest('PUT', body));

    expect(res.status).toBe(400);
    expect(mockSetNamedRivalPick).not.toHaveBeenCalled();
  });

  it('PUT blocks settings during delete-data offboarding', async () => {
    mockGetOffboardingState.mockResolvedValueOnce({
      id: 'offboarding-1',
      accountId: ACCOUNT_ID,
      mode: 'delete_data',
      status: 'pending',
      failedStep: null,
      terminalAt: null,
      accessEndsAt: null,
      teardownStartedAt: null,
      purgeAfter: null,
      purgeStartedAt: null,
      purgeCancelledAt: null,
    });

    const res = await PUT(makeRequest('PUT', { businessId: BUSINESS_ID, placeId: PLACE_ID }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_offboarding_blocked' });
    expect(mockSetNamedRivalPick).not.toHaveBeenCalled();
  });
});
