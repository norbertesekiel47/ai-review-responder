import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Set env vars BEFORE any concurrency-guard import triggers getCacheRedisOptions()
beforeAll(() => {
  process.env.REDIS_CACHE_URL = 'redis://localhost:6379';
  process.env.REDIS_CACHE_TOKEN = 'test-token';
});

// ── Mock Redis ───────────────────────────────────────────────────────

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  incr: vi.fn(),
  decr: vi.fn(),
  expire: vi.fn(),
  eval: vi.fn(),
};

vi.mock('ioredis', () => ({
  default: class MockRedis {
    get = mockRedis.get;
    set = mockRedis.set;
    incr = mockRedis.incr;
    decr = mockRedis.decr;
    expire = mockRedis.expire;
    eval = mockRedis.eval;
  },
}));

// ── Tests ────────────────────────────────────────────────────────────

describe('acquireConcurrencySlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquires slot when under limit', async () => {
    mockRedis.eval.mockResolvedValueOnce(['ok', 1]);

    const { acquireConcurrencySlot } = await import('../concurrency-guard');
    await expect(acquireConcurrencySlot('biz-001')).resolves.toBeUndefined();
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('throws ConcurrencyLimitExceededError at max+1 and releases', async () => {
    // Lua script has already rolled back (DECR'd) when it returns 'exceeded'.
    mockRedis.eval.mockResolvedValueOnce(['exceeded', 4]);

    const { acquireConcurrencySlot, ConcurrencyLimitExceededError } =
      await import('../concurrency-guard');
    await expect(acquireConcurrencySlot('biz-001')).rejects.toThrow(
      ConcurrencyLimitExceededError,
    );
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });
});

describe('releaseConcurrencySlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decrements and floors at 0', async () => {
    mockRedis.decr.mockResolvedValueOnce(-1);
    mockRedis.set.mockResolvedValueOnce('OK');

    const { releaseConcurrencySlot } = await import('../concurrency-guard');
    await releaseConcurrencySlot('biz-001');

    expect(mockRedis.decr).toHaveBeenCalled();
    // Exact key assertion: this guard's contract includes the Redis key format,
    // so assert it precisely rather than a substring (catches prefix drift).
    expect(mockRedis.set).toHaveBeenCalledWith('gen:active:biz-001', '0');
  });
});
