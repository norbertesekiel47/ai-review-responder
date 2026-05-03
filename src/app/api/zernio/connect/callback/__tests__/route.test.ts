import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisData, mockListLocations, mockGetCurrentUser, mockDeleteProfile } = vi.hoisted(() => ({
  redisData: new Map<string, string>(),
  mockListLocations: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  mockDeleteProfile: vi.fn(),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    getdel: vi.fn(async (key: string) => {
      const value = redisData.get(key) ?? null;
      redisData.delete(key);
      return value;
    }),
    get: vi.fn(async (key: string) => redisData.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      redisData.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (redisData.delete(key)) deleted++;
      }
      return deleted;
    }),
    eval: vi.fn(async (_script: string, _keyCount: number, key: string, flowId: string) => {
      const raw = redisData.get(key);
      if (!raw) return 0;
      try {
        const parsed = JSON.parse(raw) as { flowId?: string };
        if (parsed.flowId === flowId) {
          redisData.delete(key);
          return 1;
        }
      } catch {
        return 0;
      }
      return 0;
    }),
  }),
}));

vi.mock('@/lib/db/auth', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    listLocations: mockListLocations,
    deleteProfile: mockDeleteProfile,
  },
}));

import { GET } from '../route';

describe('GET /api/zernio/connect/callback', () => {
  beforeEach(() => {
    redisData.clear();
    mockListLocations.mockReset();
    mockGetCurrentUser.mockReset();
    mockDeleteProfile.mockReset();
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    process.env.SESSION_COOKIE_SECRET = 'test-session-cookie-secret';
  });

  it('accepts pendingDataToken from Zernio headless OAuth redirects', async () => {
    const state = 'zernio-returned-state';
    const businessId = 'biz-1';
    const profileId = 'profile-1';
    const userId = 'user-1';
    const flowId = 'flow-1';

    redisData.set(
      `connect_state:${state}`,
      JSON.stringify({ businessId, profileId, userId, createdAt: Date.now() }),
    );
    redisData.set(
      `connect_pending:${businessId}`,
      JSON.stringify({
        flowId,
        userId,
        started_at: Date.now(),
        status: 'oauth_in_progress',
        profileId,
        state,
      }),
    );
    mockGetCurrentUser.mockResolvedValue({ id: userId });
    mockListLocations.mockResolvedValue({
      locations: [{ id: 'loc-1', name: 'Location 1', address: '1 Main St' }],
    });

    const res = await GET(
      new Request(
        `http://localhost/api/zernio/connect/callback?state=${encodeURIComponent(
          state,
        )}&pendingDataToken=pdt-123`,
      ) as never,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost/dashboard/connect/select-location',
    );
    expect(mockListLocations).toHaveBeenCalledWith({
      profileId,
      pendingDataToken: 'pdt-123',
      connectToken: undefined,
    });
    const locationEntry = [...redisData.entries()].find(([key]) =>
      key.startsWith('connect_locations:'),
    );
    expect(locationEntry?.[1]).toContain('"connect_token":"pdt-123"');
    expect(locationEntry?.[1]).toContain('"pending_data_token":"pdt-123"');
  });

  it('uses the connect token embedded in Zernio state when no token query param is present', async () => {
    const state = 'zernio-user-profile-ts-redirect-ct_embedded123';
    const businessId = 'biz-1';
    const profileId = 'profile-1';
    const userId = 'user-1';
    const flowId = 'flow-1';

    redisData.set(
      `connect_state:${state}`,
      JSON.stringify({ businessId, profileId, userId, createdAt: Date.now() }),
    );
    redisData.set(
      `connect_pending:${businessId}`,
      JSON.stringify({
        flowId,
        userId,
        started_at: Date.now(),
        status: 'oauth_in_progress',
        profileId,
        state,
      }),
    );
    mockGetCurrentUser.mockResolvedValue({ id: userId });
    mockListLocations.mockResolvedValue({
      locations: [{ id: 'loc-1', name: 'Location 1', address: '1 Main St' }],
    });

    const res = await GET(
      new Request(
        `http://localhost/api/zernio/connect/callback?state=${encodeURIComponent(state)}`,
      ) as never,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost/dashboard/connect/select-location',
    );
    expect(mockListLocations).toHaveBeenCalledWith({
      profileId,
      pendingDataToken: 'ct_embedded123',
      connectToken: 'ct_embedded123',
    });
  });

  it('recovers state from profileId when Zernio callback omits state', async () => {
    const state = 'zernio-state-from-profile';
    const businessId = 'biz-1';
    const profileId = 'profile-1';
    const userId = 'user-1';
    const flowId = 'flow-1';

    redisData.set(`connect_profile_state:${profileId}`, state);
    redisData.set(
      `connect_state:${state}`,
      JSON.stringify({ businessId, profileId, userId, createdAt: Date.now() }),
    );
    redisData.set(
      `connect_pending:${businessId}`,
      JSON.stringify({
        flowId,
        userId,
        started_at: Date.now(),
        status: 'oauth_in_progress',
        profileId,
        state,
      }),
    );
    mockGetCurrentUser.mockResolvedValue({ id: userId });
    mockListLocations.mockResolvedValue({
      locations: [{ id: 'loc-1', name: 'Location 1', address: '1 Main St' }],
    });

    const res = await GET(
      new Request(
        `http://localhost/api/zernio/connect/callback?profileId=${encodeURIComponent(
          profileId,
        )}&pendingDataToken=pdt-123&connect_token=ct_123&platform=googlebusiness&step=locations`,
      ) as never,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost/dashboard/connect/select-location',
    );
    expect(mockListLocations).toHaveBeenCalledWith({
      profileId,
      pendingDataToken: 'pdt-123',
      connectToken: 'ct_123',
    });
    expect(redisData.has(`connect_profile_state:${profileId}`)).toBe(false);
  });

  it('cleans up the pending flow when callback has state but no connect token', async () => {
    const state = 'zernio-state-without-token';
    const businessId = 'biz-1';
    const profileId = 'profile-1';
    const userId = 'user-1';
    const flowId = 'flow-1';

    redisData.set(
      `connect_state:${state}`,
      JSON.stringify({ businessId, profileId, userId, createdAt: Date.now() }),
    );
    redisData.set(`connect_profile_state:${profileId}`, state);
    redisData.set(
      `connect_pending:${businessId}`,
      JSON.stringify({
        flowId,
        userId,
        started_at: Date.now(),
        status: 'oauth_in_progress',
        profileId,
        state,
      }),
    );
    mockDeleteProfile.mockResolvedValue(undefined);

    const res = await GET(
      new Request(
        `http://localhost/api/zernio/connect/callback?state=${encodeURIComponent(state)}`,
      ) as never,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'http://localhost/dashboard/connect?error=missing_params',
    );
    expect(redisData.has(`connect_state:${state}`)).toBe(false);
    expect(redisData.has(`connect_profile_state:${profileId}`)).toBe(false);
    expect(redisData.has(`connect_pending:${businessId}`)).toBe(false);
    expect(mockDeleteProfile).toHaveBeenCalledWith(profileId);
  });
});
