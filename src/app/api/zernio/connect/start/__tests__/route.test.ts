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
  mockDeleteAccount,
  mockAccountRows,
  mockOrphanRows,
  mockEnqueueAnalyticsEvent,
} = vi.hoisted(() => {
  const sqlCalls: Array<{ raw: string; values: unknown[] }> = [];
  // Disconnected-connection rows returned by the reconnect orphan-cleanup query.
  const mockOrphanRows: {
    value: Array<{ zernio_account_id: string | null; zernio_profile_id: string }>;
  } = { value: [] };
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
    mockDeleteAccount: vi.fn(async (_accountId: unknown) => undefined),
    mockAccountRows,
    mockOrphanRows,
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
      // Reconnect orphan-cleanup query (selects zernio_profile_id for
      // disconnected rows) is distinct from the active/pending idempotency
      // check (selects `1 AS exists`).
      if (/zernio_profile_id/.test(raw)) {
        return Promise.resolve(mockOrphanRows.value);
      }
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
    deleteAccount: (accountId: unknown) => mockDeleteAccount(accountId),
  },
}));

process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.ZERNIO_PROFILE_ID_PREFIX = 'test-profile-';

import { POST } from '../route';
import { resetServerConfigForTests } from '@/lib/config/server';

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
    mockOrphanRows.value = [];
    mockAccountRows.value = [
      {
        subscription_status: 'active',
        past_due_at: null,
        flags: {},
      },
    ];
    mockRequireRole.mockResolvedValue(ownerUser());
    // Migrated read: createProfile's name prefix now reads ZERNIO_PROFILE_ID_PREFIX
    // via the memoized getServerConfig(). The var is set once at module load (never
    // mutated), but clearing the memo here keeps the first getServerConfig() in POST
    // re-parsing the live env, immune to any import-time memo creep (#6/#7).
    resetServerConfigForTests();
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

  it('deletes the orphaned account THEN profile from a prior disconnected connection BEFORE createProfile (reconnect self-heal)', async () => {
    // A disconnected connection left an orphaned Zernio account+profile; its
    // deterministic name would otherwise collide with createProfile → 400. And
    // Zernio refuses to delete a profile that still has a connected account, so
    // the account must be deleted first.
    mockOrphanRows.value = [
      { zernio_account_id: 'orphan-account-abc', zernio_profile_id: 'orphan-profile-abc' },
    ];

    const res = await POST(makeRequest({ locationId: SECONDARY_LOCATION_ID }));

    expect(res.status).toBe(200);
    expect(mockDeleteAccount).toHaveBeenCalledWith('orphan-account-abc');
    expect(mockDeleteProfile).toHaveBeenCalledWith('orphan-profile-abc');
    expect(mockCreateProfile).toHaveBeenCalledWith({
      name: `test-profile-${SECONDARY_LOCATION_ID}`,
    });
    // Order: account → profile (Zernio blocks profile delete while an account is
    // connected) → createProfile (name now free).
    expect(mockDeleteAccount.mock.invocationCallOrder[0]!).toBeLessThan(
      mockDeleteProfile.mock.invocationCallOrder[0]!,
    );
    expect(mockDeleteProfile.mock.invocationCallOrder[0]!).toBeLessThan(
      mockCreateProfile.mock.invocationCallOrder[0]!,
    );
  });

  it('skips account deletion when an orphaned row has no account, still deletes the profile', async () => {
    mockOrphanRows.value = [{ zernio_account_id: null, zernio_profile_id: 'orphan-profile-xyz' }];

    const res = await POST(makeRequest({ locationId: SECONDARY_LOCATION_ID }));

    expect(res.status).toBe(200);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockDeleteProfile).toHaveBeenCalledWith('orphan-profile-xyz');
  });

  it('does not delete any account or profile on a fresh connect with no orphaned connection', async () => {
    const res = await POST(makeRequest({ locationId: SECONDARY_LOCATION_ID }));

    expect(res.status).toBe(200);
    expect(mockDeleteAccount).not.toHaveBeenCalled();
    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(mockCreateProfile).toHaveBeenCalled();
  });
});
