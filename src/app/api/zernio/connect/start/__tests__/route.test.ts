import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const PRIMARY_LOCATION_ID = '11111111-1111-4111-8111-111111111111';
const SECONDARY_LOCATION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ACCOUNT_LOCATION_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'user-1';

const {
  mockRequireRole,
  sqlCalls,
  mockRedis,
  mockCreateProfile,
  mockStartConnect,
  mockDeleteProfile,
  mockAccountRows,
  mockEnqueueAnalyticsEvent,
} = vi.hoisted(() => {
  const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
  const mockAccountRows: {
    value: Array<{
      subscription_status: string;
      past_due_at: string | null;
      flags: Record<string, unknown>;
    }>;
  } = {
    value: [
      {
        subscription_status: 'active',
        past_due_at: null,
        flags: {},
      },
    ],
  };

  const mockRedis = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    setex: vi.fn(async () => 'OK'),
    eval: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
  };

  return {
    mockRequireRole: vi.fn(),
    sqlCalls,
    mockRedis,
    mockCreateProfile: vi.fn(async (_input: unknown) => ({ profileId: 'profile-secondary' })),
    mockStartConnect: vi.fn(async (_input: unknown) => ({
      authUrl: 'https://zernio.test/connect',
      state: 'returned-state',
    })),
    mockDeleteProfile: vi.fn(async (_profileId: unknown) => undefined),
    mockAccountRows,
    mockEnqueueAnalyticsEvent: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: mockEnqueueAnalyticsEvent,
}));

vi.mock('@/lib/shared/csrf', () => ({
  assertSameOrigin: vi.fn(),
  SameOriginError: class SameOriginError extends Error {},
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

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => mockRedis,
}));

vi.mock('@/lib/db/server', () => ({
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.join('?');
    sqlCalls.push({ raw, values });

    if (/zernio_connections/.test(raw)) {
      return Promise.resolve(
        values.includes(PRIMARY_LOCATION_ID) ? [{ exists: 1 }] : [],
      );
    }
    if (/zernio_finalize_incidents/.test(raw)) {
      return Promise.resolve([]);
    }
    if (/businesses/.test(raw) && /accounts/.test(raw)) {
      return Promise.resolve(
        values.includes(OTHER_ACCOUNT_LOCATION_ID)
          ? []
          : mockAccountRows.value,
      );
    }

    return Promise.resolve([]);
  }),
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    createProfile: (input: unknown) => mockCreateProfile(input),
    startConnect: (input: unknown) => mockStartConnect(input),
    deleteProfile: (profileId: unknown) => mockDeleteProfile(profileId),
  },
}));

process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.ZERNIO_PROFILE_ID_PREFIX = 'test-profile-';

import { POST } from '../route';

function ownerUser() {
  return {
    id: USER_ID,
    name: 'Owner',
    email: 'owner@example.com',
    role: 'owner',
    accountId: ACCOUNT_ID,
    locationId: PRIMARY_LOCATION_ID,
  };
}

function makeRequest(body?: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/zernio/connect/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/zernio/connect/start location targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    mockAccountRows.value = [
      {
        subscription_status: 'active',
        past_due_at: null,
        flags: {},
      },
    ];
    mockRequireRole.mockResolvedValue(ownerUser());
  });

  it('starts a connect flow for the requested secondary location instead of the primary location', async () => {
    const res = await POST(makeRequest({ locationId: SECONDARY_LOCATION_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authUrl: 'https://zernio.test/connect' });
    expect(mockCreateProfile).toHaveBeenCalledWith({
      name: `test-profile-${SECONDARY_LOCATION_ID}`,
    });

    const stateWrite = (mockRedis.setex.mock.calls as unknown as [string, number, string][]).find(([key]) =>
      String(key).startsWith('connect_state:returned-state'),
    );
    expect(JSON.parse(String(stateWrite?.[2]))).toMatchObject({
      businessId: SECONDARY_LOCATION_ID,
      userId: USER_ID,
      profileId: 'profile-secondary',
    });
  });

  it('captures gbp_connect_started server-side with account scope so the funnel joins gbp_connected', async () => {
    const res = await POST(makeRequest({ locationId: SECONDARY_LOCATION_ID }));

    expect(res.status).toBe(200);
    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'gbp_connect_started',
        distinctId: ACCOUNT_ID,
        accountId: ACCOUNT_ID,
        businessId: SECONDARY_LOCATION_ID,
        properties: expect.objectContaining({
          account_id: ACCOUNT_ID,
          business_id: SECONDARY_LOCATION_ID,
        }),
      }),
    );
  });

  it('rejects a requested location that is not active in the owner account', async () => {
    const res = await POST(makeRequest({ locationId: OTHER_ACCOUNT_LOCATION_ID }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'invalid_location_scope' });
    expect(mockCreateProfile).not.toHaveBeenCalled();
  });

  it('allows a connect flow while a past-due account is still in grace', async () => {
    mockAccountRows.value = [
      {
        subscription_status: 'past_due',
        past_due_at: new Date().toISOString(),
        flags: {},
      },
    ];

    const res = await POST(makeRequest({ locationId: SECONDARY_LOCATION_ID }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authUrl: 'https://zernio.test/connect' });
    expect(mockCreateProfile).toHaveBeenCalledWith({
      name: `test-profile-${SECONDARY_LOCATION_ID}`,
    });
  });

  it('rejects read-only past-due connect before creating a Zernio profile', async () => {
    mockAccountRows.value = [
      {
        subscription_status: 'past_due',
        past_due_at: '2024-01-01T00:00:00.000Z',
        flags: {},
      },
    ];

    const res = await POST(makeRequest({ locationId: SECONDARY_LOCATION_ID }));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(mockCreateProfile).not.toHaveBeenCalled();
    expect(mockStartConnect).not.toHaveBeenCalled();
  });
});
