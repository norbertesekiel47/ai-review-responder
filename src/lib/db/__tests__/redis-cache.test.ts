import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisGet, redisSet, redisEval } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: class RedisMock {
    get = redisGet;
    set = redisSet;
    eval = redisEval;
  },
}));

import {
  CACHE_LOCK_POLL_ATTEMPTS,
  CACHE_LOCK_POLL_INTERVAL_MS,
  withTtlCache,
} from '../redis-cache';

/** The stampede lock is `SET <key>:lock <token> PX <ms> NX`; the payload write is `SET <key> <json> EX <s>`. */
const isLockSet = (call: unknown[]) => call[2] === 'PX' && call[4] === 'NX';
const isPayloadSet = (call: unknown[]) => call[2] === 'EX';

describe('withTtlCache', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): a leftover `mockRejectedValueOnce`
    // from a previous test would otherwise leak into the next one's lock SET.
    vi.resetAllMocks();
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    redisGet.mockResolvedValue(null);
    // Default: the lock is free (NX succeeds) and the payload write succeeds.
    redisSet.mockResolvedValue('OK');
    redisEval.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a JSON cache hit without computing', async () => {
    redisGet.mockResolvedValue(JSON.stringify({ value: 1 }));
    const compute = vi.fn();

    await expect(withTtlCache('key', 45, compute, 'dashboard/service')).resolves.toEqual({ value: 1 });
    expect(compute).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('computes a miss and writes the exact TTL', async () => {
    const compute = vi.fn().mockResolvedValue({ value: 2 });

    await expect(withTtlCache('key', 45, compute, 'dashboard/service')).resolves.toEqual({ value: 2 });
    expect(redisSet).toHaveBeenCalledWith('key', JSON.stringify({ value: 2 }), 'EX', 45);
  });

  it('fails open on read and write errors while preserving the source label', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    redisGet.mockRejectedValueOnce(new Error('read down'));
    // A failed read marks Redis unhealthy, so NO lock SET is attempted: the
    // only SET is the payload write, which fails here.
    redisSet.mockRejectedValueOnce(new Error('write down'));

    await expect(withTtlCache('key', 45, async () => 'fresh', 'dashboard/aggregate')).resolves.toBe('fresh');
    expect(errorSpy).toHaveBeenNthCalledWith(
      1,
      '[dashboard/aggregate] cache read failed (computing fresh):',
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenNthCalledWith(
      2,
      '[dashboard/aggregate] cache write failed (serving fresh):',
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledTimes(2);
    // Degraded miss = exactly the two commands it always cost (read + write).
    expect(redisGet).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledTimes(1);
    expect(redisSet.mock.calls.filter(isLockSet)).toHaveLength(0);
    expect(redisEval).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('propagates compute errors without caching them, and releases the lock', async () => {
    await expect(
      withTtlCache('key', 45, async () => { throw new Error('compute failed'); }, 'dashboard/service'),
    ).rejects.toThrow('compute failed');
    expect(redisSet.mock.calls.filter(isPayloadSet)).toHaveLength(0);
    expect(redisEval).toHaveBeenCalledTimes(1);
  });

  describe('stampede guard', () => {
    it('takes a short NX lock on a miss and releases it by token after the write', async () => {
      await withTtlCache('key', 45, async () => 'fresh', 'dashboard/service');

      const lockCalls = redisSet.mock.calls.filter(isLockSet);
      expect(lockCalls).toHaveLength(1);
      const [lockKey, token, , ttlMs] = lockCalls[0]!;
      expect(lockKey).toBe('key:lock');
      expect(typeof token).toBe('string');
      expect(ttlMs).toBeGreaterThan(0);
      // Compare-and-delete: the release carries the SAME token, so an expired
      // holder can never delete a later caller's lock.
      expect(redisEval).toHaveBeenCalledWith(expect.stringContaining("redis.call('del'"), 1, 'key:lock', token);
      // Write before release, so a poller that sees the lock gone finds the value.
      const writeIdx = redisSet.mock.calls.findIndex(isPayloadSet);
      expect(writeIdx).toBeGreaterThan(redisSet.mock.calls.findIndex(isLockSet));
      expect(redisEval.mock.invocationCallOrder[0]!).toBeGreaterThan(redisSet.mock.invocationCallOrder[writeIdx]!);
    });

    it('a second caller that loses the lock returns the value the holder wrote, computing nothing', async () => {
      vi.useFakeTimers();
      const store = new Map<string, string>();
      let lockHeld = false;
      redisGet.mockImplementation(async (key: string) => store.get(key) ?? null);
      redisSet.mockImplementation(async (key: string, value: string, mode: string) => {
        if (mode === 'PX') {
          if (lockHeld) return null;
          lockHeld = true;
          return 'OK';
        }
        store.set(key, value);
        return 'OK';
      });
      redisEval.mockImplementation(async () => { lockHeld = false; return 1; });

      let releaseHolder!: () => void;
      const holderCompute = vi.fn(
        () => new Promise<string>((resolve) => { releaseHolder = () => resolve('holder-value'); }),
      );
      const followerCompute = vi.fn(async () => 'follower-value');

      const holder = withTtlCache('key', 45, holderCompute, 'dashboard/service');
      // Let the holder take the lock before the follower arrives.
      await vi.advanceTimersByTimeAsync(0);
      const follower = withTtlCache('key', 45, followerCompute, 'dashboard/service');
      await vi.advanceTimersByTimeAsync(0);
      expect(holderCompute).toHaveBeenCalledTimes(1);

      // Holder finishes within the follower's poll budget.
      releaseHolder();
      await vi.advanceTimersByTimeAsync(CACHE_LOCK_POLL_INTERVAL_MS);

      await expect(holder).resolves.toBe('holder-value');
      await expect(follower).resolves.toBe('holder-value');
      expect(followerCompute).not.toHaveBeenCalled();
    });

    it('a follower whose poll budget expires computes for itself (never blocks past the budget)', async () => {
      vi.useFakeTimers();
      // Lock permanently held by someone else; the value never appears.
      redisSet.mockImplementation(async (_key: string, _value: string, mode: string) =>
        mode === 'PX' ? null : 'OK',
      );
      const compute = vi.fn(async () => 'own-value');

      const pending = withTtlCache('key', 45, compute, 'dashboard/service');
      await vi.advanceTimersByTimeAsync(0);
      expect(compute).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(CACHE_LOCK_POLL_ATTEMPTS * CACHE_LOCK_POLL_INTERVAL_MS);
      await expect(pending).resolves.toBe('own-value');
      expect(compute).toHaveBeenCalledTimes(1);
      // Polled exactly the budget: initial read + one read per attempt.
      expect(redisGet).toHaveBeenCalledTimes(1 + CACHE_LOCK_POLL_ATTEMPTS);
      // A non-holder never releases a lock it does not own.
      expect(redisEval).not.toHaveBeenCalled();
    });

    it('a lock-acquire failure computes immediately (fail-open, no poll wait)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      redisSet.mockImplementation(async (_key: string, _value: string, mode: string) => {
        if (mode === 'PX') throw new Error('lock down');
        return 'OK';
      });
      const compute = vi.fn(async () => 'fresh');

      await expect(withTtlCache('key', 45, compute, 'dashboard/service')).resolves.toBe('fresh');
      expect(compute).toHaveBeenCalledTimes(1);
      expect(redisGet).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[dashboard/service] cache lock failed (computing fresh):',
        expect.any(Error),
      );
      expect(redisEval).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('skips the release after a failed payload write (no third command on a sick Redis)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      // Lock SET succeeds, payload SET fails.
      redisSet.mockResolvedValueOnce('OK').mockRejectedValueOnce(new Error('write down'));

      await expect(withTtlCache('key', 45, async () => 'fresh', 'dashboard/service')).resolves.toBe('fresh');
      expect(redisSet.mock.calls.filter(isLockSet)).toHaveLength(1);
      expect(redisEval).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[dashboard/service] cache write failed (serving fresh):',
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it('a failed release is logged and swallowed (the lock expires on its own)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      redisEval.mockRejectedValue(new Error('eval down'));

      await expect(withTtlCache('key', 45, async () => 'fresh', 'dashboard/service')).resolves.toBe('fresh');
      expect(errorSpy).toHaveBeenCalledWith(
        '[dashboard/service] cache lock release failed (lock expires on its own):',
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });
  });
});
