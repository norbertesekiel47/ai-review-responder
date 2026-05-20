import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisData, evalCalls, mockDeleteProfile } = vi.hoisted(() => ({
  redisData: new Map<string, string>(),
  evalCalls: [] as Array<{ key: string; arg: string }>,
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
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (redisData.delete(key)) deleted++;
      }
      return deleted;
    }),
    // luaDeletePendingByFlowIdAnyStatus: ARGV is a flowId.
    eval: vi.fn(async (_script: string, _keyCount: number, key: string, arg: string) => {
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
    }),
  }),
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: { deleteProfile: mockDeleteProfile },
}));

import { cleanupAfterOauthDenial } from '../oauth-denial';

const BUSINESS_ID = 'biz-1';
const PROFILE_ID = 'profile-1';
const STATE = 'state-denial';
const FLOW_ID = 'flow-1';

function seed(pendingOverrides: Record<string, unknown> = {}) {
  redisData.set(
    `connect_state:${STATE}`,
    JSON.stringify({ businessId: BUSINESS_ID, profileId: PROFILE_ID, userId: 'user-1', createdAt: Date.now() }),
  );
  redisData.set(
    `connect_pending:${BUSINESS_ID}`,
    JSON.stringify({
      flowId: FLOW_ID,
      userId: 'user-1',
      started_at: Date.now(),
      status: 'oauth_in_progress',
      profileId: PROFILE_ID,
      state: STATE,
      ...pendingOverrides,
    }),
  );
  redisData.set(`connect_profile_state:${PROFILE_ID}`, STATE);
}

describe('cleanupAfterOauthDenial', () => {
  beforeEach(() => {
    redisData.clear();
    evalCalls.length = 0;
    mockDeleteProfile.mockReset();
    mockDeleteProfile.mockResolvedValue(undefined);
  });

  it('claims state, CAS-deletes the matching pending, deletes profile + profile_state', async () => {
    seed();

    await cleanupAfterOauthDenial(STATE);

    expect(redisData.has(`connect_state:${STATE}`)).toBe(false);
    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(false);
    expect(redisData.has(`connect_profile_state:${PROFILE_ID}`)).toBe(false);
    expect(evalCalls).toEqual([{ key: `connect_pending:${BUSINESS_ID}`, arg: FLOW_ID }]);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('does NOT delete pending when state does not match', async () => {
    seed({ state: 'a-different-state' });

    await cleanupAfterOauthDenial(STATE);

    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(true);
    expect(evalCalls).toHaveLength(0);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('does NOT delete pending when profileId does not match', async () => {
    seed({ profileId: 'other-profile' });

    await cleanupAfterOauthDenial(STATE);

    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(true);
    expect(evalCalls).toHaveLength(0);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('is a no-op (no profile delete) when no state blob exists', async () => {
    await cleanupAfterOauthDenial(STATE);
    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(evalCalls).toHaveLength(0);
  });

  it('swallows deleteProfile errors and never throws', async () => {
    seed();
    mockDeleteProfile.mockRejectedValue(new Error('zernio down'));

    await expect(cleanupAfterOauthDenial(STATE)).resolves.toBeUndefined();
    // pending CAS-delete still ran before the profile delete attempt.
    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(false);
  });

  it('leaves malformed pending untouched and still deletes profile', async () => {
    redisData.set(
      `connect_state:${STATE}`,
      JSON.stringify({ businessId: BUSINESS_ID, profileId: PROFILE_ID, userId: 'user-1', createdAt: Date.now() }),
    );
    redisData.set(`connect_pending:${BUSINESS_ID}`, 'not-json');

    await cleanupAfterOauthDenial(STATE);

    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(true);
    expect(evalCalls).toHaveLength(0);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });
});
