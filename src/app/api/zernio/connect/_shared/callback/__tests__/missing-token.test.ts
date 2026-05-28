import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  redisData,
  evalCalls,
  mockGetdel,
  mockGet,
  mockDel,
  mockEval,
  mockDeleteProfile,
} = vi.hoisted(() => ({
  redisData: new Map<string, string>(),
  evalCalls: [] as Array<{ key: string; arg: string }>,
  mockGetdel: vi.fn(),
  mockGet: vi.fn(),
  mockDel: vi.fn(),
  mockEval: vi.fn(),
  mockDeleteProfile: vi.fn(),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    getdel: mockGetdel,
    get: mockGet,
    del: mockDel,
    eval: mockEval,
  }),
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: { deleteProfile: mockDeleteProfile },
}));

import { cleanupMissingTokenState } from '../missing-token';

const BUSINESS_ID = 'biz-1';
const PROFILE_ID = 'profile-1';
const STATE = 'state-missing-token';
const FLOW_ID = 'flow-1';

const stateKey = `connect_state:${STATE}`;
const pendingKey = `connect_pending:${BUSINESS_ID}`;
const profileStateKey = `connect_profile_state:${PROFILE_ID}`;

function seed(pendingOverrides: Record<string, unknown> = {}) {
  redisData.set(
    stateKey,
    JSON.stringify({
      businessId: BUSINESS_ID,
      profileId: PROFILE_ID,
      userId: 'user-1',
      createdAt: 123,
    }),
  );
  redisData.set(
    pendingKey,
    JSON.stringify({
      flowId: FLOW_ID,
      userId: 'user-1',
      started_at: 123,
      status: 'oauth_in_progress',
      profileId: PROFILE_ID,
      state: STATE,
      ...pendingOverrides,
    }),
  );
  redisData.set(profileStateKey, STATE);
}

describe('cleanupMissingTokenState', () => {
  beforeEach(() => {
    redisData.clear();
    evalCalls.length = 0;

    mockDeleteProfile.mockReset();
    mockDeleteProfile.mockResolvedValue(undefined);

    mockGetdel.mockReset();
    mockGetdel.mockImplementation(async (key: string) => {
      const value = redisData.get(key) ?? null;
      redisData.delete(key);
      return value;
    });

    mockGet.mockReset();
    mockGet.mockImplementation(async (key: string) => redisData.get(key) ?? null);

    mockDel.mockReset();
    mockDel.mockImplementation(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (redisData.delete(key)) deleted++;
      }
      return deleted;
    });

    mockEval.mockReset();
    // luaDeletePendingByFlowIdAnyStatus: ARGV is a flowId.
    mockEval.mockImplementation(
      async (_script: string, _keyCount: number, key: string, arg: string) => {
        evalCalls.push({ key, arg });
        const raw = redisData.get(key);
        if (!raw) return 0;
        try {
          const parsed = JSON.parse(raw) as { flowId?: string };
          if (parsed.flowId === arg) {
            redisData.delete(key);
            return 1;
          }
        } catch {
          return 0;
        }
        return 0;
      },
    );
  });

  it('claims state, deletes profile_state, CAS-deletes matching pending, deletes profile', async () => {
    seed();

    await cleanupMissingTokenState(STATE);

    expect(redisData.has(stateKey)).toBe(false);
    expect(redisData.has(profileStateKey)).toBe(false);
    expect(redisData.has(pendingKey)).toBe(false);
    expect(evalCalls).toEqual([{ key: pendingKey, arg: FLOW_ID }]);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('is a no-op (no profile delete) when no state blob exists', async () => {
    await cleanupMissingTokenState(STATE);

    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(evalCalls).toHaveLength(0);
  });

  it('swallows a state GETDEL rejection and treats it as no blob', async () => {
    seed();
    mockGetdel.mockRejectedValueOnce(new Error('redis down'));

    await expect(cleanupMissingTokenState(STATE)).resolves.toBeUndefined();

    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(evalCalls).toHaveLength(0);
  });

  it('returns early on a malformed state blob without deleting the profile', async () => {
    redisData.set(stateKey, 'not-json');

    await cleanupMissingTokenState(STATE);

    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(evalCalls).toHaveLength(0);
  });

  it('does NOT delete pending when the stored state does not match', async () => {
    seed({ state: 'a-different-state' });

    await cleanupMissingTokenState(STATE);

    expect(redisData.has(pendingKey)).toBe(true);
    expect(evalCalls).toHaveLength(0);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('does NOT delete pending when the stored profileId does not match', async () => {
    seed({ profileId: 'other-profile' });

    await cleanupMissingTokenState(STATE);

    expect(redisData.has(pendingKey)).toBe(true);
    expect(evalCalls).toHaveLength(0);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('leaves a malformed pending marker untouched and still deletes the profile', async () => {
    redisData.set(
      stateKey,
      JSON.stringify({
        businessId: BUSINESS_ID,
        profileId: PROFILE_ID,
        userId: 'user-1',
        createdAt: 123,
      }),
    );
    redisData.set(pendingKey, 'not-json');
    redisData.set(profileStateKey, STATE);

    await cleanupMissingTokenState(STATE);

    expect(redisData.has(pendingKey)).toBe(true);
    expect(evalCalls).toHaveLength(0);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('swallows an eval (CAS-delete) rejection and still deletes the profile', async () => {
    seed();
    mockEval.mockRejectedValueOnce(new Error('eval failed'));

    await expect(cleanupMissingTokenState(STATE)).resolves.toBeUndefined();

    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('swallows a deleteProfile rejection and never throws', async () => {
    seed();
    mockDeleteProfile.mockRejectedValue(new Error('zernio down'));

    await expect(cleanupMissingTokenState(STATE)).resolves.toBeUndefined();
    // pending CAS-delete still ran before the profile delete attempt.
    expect(redisData.has(pendingKey)).toBe(false);
  });
});
