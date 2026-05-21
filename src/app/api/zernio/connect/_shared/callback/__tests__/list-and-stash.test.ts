import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisData, casEvalCalls, mockListLocations, mockDeleteProfile } = vi.hoisted(() => ({
  redisData: new Map<string, string>(),
  casEvalCalls: [] as Array<{ key: string; value: string }>,
  mockListLocations: vi.fn(),
  mockDeleteProfile: vi.fn(),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: vi.fn(async (key: string) => redisData.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      redisData.set(key, value);
      return 'OK';
    }),
    // luaCASDelByValue: delete KEYS[1] only if its stored value byte-equals ARGV[1].
    eval: vi.fn(async (_script: string, _keyCount: number, key: string, value: string) => {
      casEvalCalls.push({ key, value });
      if (redisData.get(key) === value) {
        redisData.delete(key);
        return 1;
      }
      return 0;
    }),
  }),
}));

vi.mock('@/lib/zernio/client', () => ({
  zernioClient: {
    listLocations: mockListLocations,
    deleteProfile: mockDeleteProfile,
  },
}));

import { listLocationsAndStash } from '../list-and-stash';
import type { ConnectStateBlob, ConnectPendingMarker } from '@/lib/zernio/types';

const BUSINESS_ID = 'biz-1';
const PROFILE_ID = 'profile-1';
const USER_ID = 'user-1';
const STATE = 'state-list';
const FLOW_ID = 'flow-1';

const stored: ConnectStateBlob = {
  businessId: BUSINESS_ID,
  profileId: PROFILE_ID,
  userId: USER_ID,
  createdAt: Date.now(),
} as ConnectStateBlob;

const pending: ConnectPendingMarker = {
  flowId: FLOW_ID,
  userId: USER_ID,
  started_at: Date.now(),
  status: 'oauth_in_progress',
  profileId: PROFILE_ID,
  state: STATE,
} as ConnectPendingMarker;

function pendingJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    flowId: FLOW_ID,
    userId: USER_ID,
    started_at: Date.now(),
    status: 'oauth_in_progress',
    profileId: PROFILE_ID,
    state: STATE,
    ...overrides,
  });
}

const baseArgs = {
  stored,
  pending,
  state: STATE,
  pendingDataToken: 'pdt-123',
  apiConnectToken: 'ct_123' as string | undefined,
};

describe('listLocationsAndStash', () => {
  beforeEach(() => {
    redisData.clear();
    casEvalCalls.length = 0;
    mockListLocations.mockReset();
    mockDeleteProfile.mockReset();
    mockDeleteProfile.mockResolvedValue(undefined);
  });

  it('ok: stashes connect_locations and returns sessionId', async () => {
    redisData.set(`connect_pending:${BUSINESS_ID}`, pendingJson());
    mockListLocations.mockResolvedValue({
      locations: [{ id: 'loc-1', name: 'Loc 1', address: '1 Main' }],
    });

    const result = await listLocationsAndStash(baseArgs);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const stashed = redisData.get(`connect_locations:${result.sessionId}`);
      expect(stashed).toBeTruthy();
      expect(stashed).toContain('"connect_token":"ct_123"');
      expect(stashed).toContain('"pending_data_token":"pdt-123"');
    }
    expect(mockDeleteProfile).not.toHaveBeenCalled();
  });

  it('controlled flow_cancelled_during_listing: no in-module cleanup', async () => {
    // pending absent on the second re-check
    mockListLocations.mockResolvedValue({ locations: [] });

    const result = await listLocationsAndStash(baseArgs);

    expect(result).toEqual({
      ok: false,
      kind: 'controlled',
      code: 'flow_cancelled_during_listing',
      cleanupProfileId: PROFILE_ID,
    });
    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(casEvalCalls).toHaveLength(0);
  });

  it('controlled malformed_pending: no in-module cleanup', async () => {
    redisData.set(`connect_pending:${BUSINESS_ID}`, 'not-json');
    mockListLocations.mockResolvedValue({ locations: [] });

    const result = await listLocationsAndStash(baseArgs);

    expect(result).toEqual({
      ok: false,
      kind: 'controlled',
      code: 'malformed_pending',
      cleanupProfileId: PROFILE_ID,
    });
    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(true);
    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(casEvalCalls).toHaveLength(0);
  });

  it('controlled flow_superseded_during_listing: no in-module cleanup', async () => {
    // a newer flow overwrote pending during the network call
    redisData.set(`connect_pending:${BUSINESS_ID}`, pendingJson({ flowId: 'flow-2' }));
    mockListLocations.mockResolvedValue({ locations: [] });

    const result = await listLocationsAndStash(baseArgs);

    expect(result).toEqual({
      ok: false,
      kind: 'controlled',
      code: 'flow_superseded_during_listing',
      cleanupProfileId: PROFILE_ID,
    });
    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(true);
    expect(mockDeleteProfile).not.toHaveBeenCalled();
    expect(casEvalCalls).toHaveLength(0);
  });

  it('thrown: runs value-equal CAS pending cleanup + deleteProfile, returns zernio_listlocations_failed', async () => {
    const currentPending = pendingJson();
    redisData.set(`connect_pending:${BUSINESS_ID}`, currentPending);
    mockListLocations.mockRejectedValue(new Error('zernio 500'));

    const result = await listLocationsAndStash(baseArgs);

    expect(result).toEqual({ ok: false, kind: 'thrown', code: 'zernio_listlocations_failed' });
    // Value-equal CAS delete fired and removed the marker.
    expect(casEvalCalls).toEqual([{ key: `connect_pending:${BUSINESS_ID}`, value: currentPending }]);
    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(false);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });

  it('thrown: does NOT delete pending when a newer flow overwrote it', async () => {
    redisData.set(`connect_pending:${BUSINESS_ID}`, pendingJson({ profileId: 'newer-profile' }));
    mockListLocations.mockRejectedValue(new Error('zernio 500'));

    const result = await listLocationsAndStash(baseArgs);

    expect(result).toEqual({ ok: false, kind: 'thrown', code: 'zernio_listlocations_failed' });
    // state/profile no longer ours → shouldDelete=false → no CAS eval.
    expect(casEvalCalls).toHaveLength(0);
    expect(redisData.has(`connect_pending:${BUSINESS_ID}`)).toBe(true);
    expect(mockDeleteProfile).toHaveBeenCalledWith(PROFILE_ID);
  });
});
