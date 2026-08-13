import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redisGet, redisSet } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: class RedisMock {
    get = redisGet;
    set = redisSet;
  },
}));

import { withTtlCache } from '../redis-cache';

describe('withTtlCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
    redisGet.mockResolvedValue(null);
    redisSet.mockResolvedValue('OK');
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
    errorSpy.mockRestore();
  });

  it('propagates compute errors without caching them', async () => {
    await expect(
      withTtlCache('key', 45, async () => { throw new Error('compute failed'); }, 'dashboard/service'),
    ).rejects.toThrow('compute failed');
    expect(redisSet).not.toHaveBeenCalled();
  });
});
