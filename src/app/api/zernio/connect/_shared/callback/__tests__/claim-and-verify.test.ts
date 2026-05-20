import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisData, throwOn, mockGetCurrentUser } = vi.hoisted(() => ({
  redisData: new Map<string, string>(),
  throwOn: { getdel: false, getPending: false },
  mockGetCurrentUser: vi.fn(),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    getdel: vi.fn(async (key: string) => {
      if (throwOn.getdel) throw new Error('redis getdel down');
      const value = redisData.get(key) ?? null;
      redisData.delete(key);
      return value;
    }),
    get: vi.fn(async (key: string) => {
      if (throwOn.getPending) throw new Error('redis get down');
      return redisData.get(key) ?? null;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (redisData.delete(key)) deleted++;
      }
      return deleted;
    }),
  }),
}));

vi.mock('@/lib/db/auth', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

import { claimAndVerifyConnectState } from '../claim-and-verify';

const BUSINESS_ID = 'biz-1';
const PROFILE_ID = 'profile-1';
const USER_ID = 'user-1';
const STATE = 'state-claim';
const FLOW_ID = 'flow-1';
const req = {} as never;

function seedState() {
  redisData.set(
    `connect_state:${STATE}`,
    JSON.stringify({ businessId: BUSINESS_ID, profileId: PROFILE_ID, userId: USER_ID, createdAt: Date.now() }),
  );
}

function seedPending(overrides: Record<string, unknown> = {}) {
  redisData.set(
    `connect_pending:${BUSINESS_ID}`,
    JSON.stringify({
      flowId: FLOW_ID,
      userId: USER_ID,
      started_at: Date.now(),
      status: 'oauth_in_progress',
      profileId: PROFILE_ID,
      state: STATE,
      ...overrides,
    }),
  );
}

describe('claimAndVerifyConnectState', () => {
  beforeEach(() => {
    redisData.clear();
    throwOn.getdel = false;
    throwOn.getPending = false;
    mockGetCurrentUser.mockReset();
  });

  it('returns ok:true with stored/pending/userId on the happy path', async () => {
    seedState();
    seedPending();
    mockGetCurrentUser.mockResolvedValue({ id: USER_ID });

    const result = await claimAndVerifyConnectState(req, STATE);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stored.profileId).toBe(PROFILE_ID);
      expect(result.pending.flowId).toBe(FLOW_ID);
      expect(result.userId).toBe(USER_ID);
    }
    // State was atomically claimed; profile_state best-effort delete ran.
    expect(redisData.has(`connect_state:${STATE}`)).toBe(false);
  });

  it('internal_error with NO cleanup when state GETDEL throws', async () => {
    throwOn.getdel = true;

    const result = await claimAndVerifyConnectState(req, STATE);

    expect(result).toEqual({ ok: false, code: 'internal_error', cleanupProfileId: null });
  });

  it('state_expired with NO cleanup when state blob is missing', async () => {
    const result = await claimAndVerifyConnectState(req, STATE);
    expect(result).toEqual({ ok: false, code: 'state_expired', cleanupProfileId: null });
  });

  it('malformed_state with NO cleanup when state blob is not JSON', async () => {
    redisData.set(`connect_state:${STATE}`, 'not-json');
    const result = await claimAndVerifyConnectState(req, STATE);
    expect(result).toEqual({ ok: false, code: 'malformed_state', cleanupProfileId: null });
  });

  it('internal_error WITH cleanup profileId when pending GET throws', async () => {
    seedState();
    throwOn.getPending = true;

    const result = await claimAndVerifyConnectState(req, STATE);

    expect(result).toEqual({ ok: false, code: 'internal_error', cleanupProfileId: PROFILE_ID });
  });

  it('pending_missing WITH cleanup profileId when pending is absent', async () => {
    seedState();

    const result = await claimAndVerifyConnectState(req, STATE);

    expect(result).toEqual({ ok: false, code: 'pending_missing', cleanupProfileId: PROFILE_ID });
  });

  it('malformed_pending WITH cleanup profileId when pending is not JSON', async () => {
    seedState();
    redisData.set(`connect_pending:${BUSINESS_ID}`, 'not-json');

    const result = await claimAndVerifyConnectState(req, STATE);

    expect(result).toEqual({ ok: false, code: 'malformed_pending', cleanupProfileId: PROFILE_ID });
  });

  it('flow_mismatch WITH cleanup profileId when pending fields disagree', async () => {
    seedState();
    seedPending({ status: 'finalizing' });

    const result = await claimAndVerifyConnectState(req, STATE);

    expect(result).toEqual({ ok: false, code: 'flow_mismatch', cleanupProfileId: PROFILE_ID });
  });

  it('user_mismatch WITH cleanup profileId when the session user differs', async () => {
    seedState();
    seedPending();
    mockGetCurrentUser.mockResolvedValue({ id: 'someone-else' });

    const result = await claimAndVerifyConnectState(req, STATE);

    expect(result).toEqual({ ok: false, code: 'user_mismatch', cleanupProfileId: PROFILE_ID });
  });

  it('user_mismatch WITH cleanup profileId when there is no session user', async () => {
    seedState();
    seedPending();
    mockGetCurrentUser.mockResolvedValue(null);

    const result = await claimAndVerifyConnectState(req, STATE);

    expect(result).toEqual({ ok: false, code: 'user_mismatch', cleanupProfileId: PROFILE_ID });
  });
});
