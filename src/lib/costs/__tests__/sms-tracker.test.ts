import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';

// Set env vars BEFORE any tracker imports trigger getCacheRedisOptions()
beforeAll(() => {
  process.env.REDIS_CACHE_URL = 'redis://localhost:6379';
  process.env.REDIS_CACHE_TOKEN = 'test-token';
});

// ── Mock Redis ───────────────────────────────────────────────────────

const mockPipelineExec = vi.fn();
const mockPipeline = {
  incrby: vi.fn().mockReturnThis(),
  decrby: vi.fn().mockReturnThis(),
  expire: vi.fn().mockReturnThis(),
  exec: mockPipelineExec,
};

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  incr: vi.fn(),
  decr: vi.fn(),
  expire: vi.fn(),
  eval: vi.fn(),
  pipeline: vi.fn().mockReturnValue(mockPipeline),
};

vi.mock('ioredis', () => ({
  default: class MockRedis {
    get = mockRedis.get;
    set = mockRedis.set;
    incr = mockRedis.incr;
    decr = mockRedis.decr;
    expire = mockRedis.expire;
    eval = mockRedis.eval;
    pipeline = mockRedis.pipeline;
  },
}));

// ── Tests ────────────────────────────────────────────────────────────

describe('reserveSmsCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipeline.incrby.mockReturnThis();
    mockPipeline.decrby.mockReturnThis();
    mockPipeline.expire.mockReturnThis();
    // Clean slate for env parsing
    delete process.env.SMS_DAILY_LIMIT_CENTS_PER_BUSINESS;
    delete process.env.SMS_DAILY_LIMIT_CENTS_GLOBAL;
  });

  it('increments per-business and global counters by 1 and returns YYYY-MM-DD', async () => {
    // Lua EVAL returns ['ok', bizTotal, globalTotal] on success.
    mockRedis.eval.mockResolvedValueOnce(['ok', 1, 1]);

    const { reserveSmsCost } = await import('../sms-tracker');
    const dateStr = await reserveSmsCost('biz-001');

    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    // numKeys slot
    expect(evalArgs[1]).toBe(2);
    // KEYS[1] = per-business, KEYS[2] = global
    expect(evalArgs[2]).toBe(`cost:sms:biz-001:${dateStr}`);
    expect(evalArgs[3]).toBe(`cost:sms:global:${dateStr}`);
    // ARGV[1] = cost, ARGV[2] = bizCap (10), ARGV[3] = globalCap (500), ARGV[4] = ttl (86400)
    expect(evalArgs[4]).toBe('1');
    expect(evalArgs[5]).toBe('10');
    expect(evalArgs[6]).toBe('500');
    expect(evalArgs[7]).toBe('86400');
  });

  it('throws DailySmsLimitExceededError(per_business) when biz cap exceeded', async () => {
    // Lua script has already rolled back internally when it returns 'per_business'.
    mockRedis.eval.mockResolvedValueOnce(['per_business', 11, 50]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.name).toBe('DailySmsLimitExceededError');
    expect(err.scope).toBe('per_business');
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('throws DailySmsLimitExceededError(global) when global cap exceeded', async () => {
    mockRedis.eval.mockResolvedValueOnce(['global', 5, 501]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('global');
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('atomic script issues a single EVAL — no separate pipeline round-trips', async () => {
    mockRedis.eval.mockResolvedValueOnce(['ok', 1, 1]);

    const { reserveSmsCost } = await import('../sms-tracker');
    await reserveSmsCost('biz-001');

    // Exactly one EVAL; no fallback pipeline was issued.
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    expect(mockPipeline.incrby).not.toHaveBeenCalled();
    expect(mockPipeline.decrby).not.toHaveBeenCalled();
    expect(mockPipeline.expire).not.toHaveBeenCalled();
  });
});

describe('refundSmsCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipeline.decrby.mockReturnThis();
    mockPipelineExec.mockResolvedValueOnce([[null, 0], [null, 0]]);
  });

  it('decrements per-business and global counters by 1 using the caller-supplied date', async () => {
    const { refundSmsCost } = await import('../sms-tracker');
    await refundSmsCost('biz-001', '2026-04-21');

    expect(mockPipeline.decrby).toHaveBeenCalledWith(
      'cost:sms:biz-001:2026-04-21',
      1,
    );
    expect(mockPipeline.decrby).toHaveBeenCalledWith(
      'cost:sms:global:2026-04-21',
      1,
    );
  });

  it('refund with a stale date decrements the stale key, not today', async () => {
    const { refundSmsCost } = await import('../sms-tracker');
    const staleDate = '2026-04-20'; // yesterday
    const today = new Date().toISOString().slice(0, 10);

    await refundSmsCost('biz-001', staleDate);

    // Stale date was decremented
    expect(mockPipeline.decrby).toHaveBeenCalledWith(
      `cost:sms:biz-001:${staleDate}`,
      1,
    );
    expect(mockPipeline.decrby).toHaveBeenCalledWith(
      `cost:sms:global:${staleDate}`,
      1,
    );
    // Today's keys were NOT touched (only relevant if dates actually differ)
    if (today !== staleDate) {
      expect(mockPipeline.decrby).not.toHaveBeenCalledWith(
        `cost:sms:biz-001:${today}`,
        1,
      );
      expect(mockPipeline.decrby).not.toHaveBeenCalledWith(
        `cost:sms:global:${today}`,
        1,
      );
    }
  });
});

describe('env parsing', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    mockPipeline.incrby.mockReturnThis();
    mockPipeline.decrby.mockReturnThis();
    mockPipeline.expire.mockReturnThis();
    delete process.env.SMS_DAILY_LIMIT_CENTS_PER_BUSINESS;
    delete process.env.SMS_DAILY_LIMIT_CENTS_GLOBAL;
    warnSpy.mockClear();
  });

  afterEach(() => {
    delete process.env.SMS_DAILY_LIMIT_CENTS_PER_BUSINESS;
    delete process.env.SMS_DAILY_LIMIT_CENTS_GLOBAL;
  });

  it('falls back to default 10 when SMS_DAILY_LIMIT_CENTS_PER_BUSINESS is malformed', async () => {
    process.env.SMS_DAILY_LIMIT_CENTS_PER_BUSINESS = 'not-a-number';
    // Lua sees the default cap and returns 'per_business' after internal rollback.
    mockRedis.eval.mockResolvedValueOnce(['per_business', 11, 50]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('per_business');
    expect(warnSpy).toHaveBeenCalled();
    // Confirm the caps passed to the Lua script match the fallbacks.
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    expect(evalArgs[5]).toBe('10');
    expect(evalArgs[6]).toBe('500');
  });

  it('falls back to default 10 when SMS_DAILY_LIMIT_CENTS_PER_BUSINESS is unset', async () => {
    // (already deleted in beforeEach)
    mockRedis.eval.mockResolvedValueOnce(['per_business', 11, 50]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('per_business');
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    expect(evalArgs[5]).toBe('10');
  });

  it('uses default global cap 500 when unset', async () => {
    mockRedis.eval.mockResolvedValueOnce(['global', 5, 501]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('global');
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    expect(evalArgs[6]).toBe('500');
  });

  it('honours a valid SMS_DAILY_LIMIT_CENTS_PER_BUSINESS override', async () => {
    process.env.SMS_DAILY_LIMIT_CENTS_PER_BUSINESS = '3';
    mockRedis.eval.mockResolvedValueOnce(['per_business', 4, 50]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('per_business');
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    expect(evalArgs[5]).toBe('3');
  });

  it('allows bizTotal equal to the cap (boundary: cap is inclusive)', async () => {
    // bizTotal 10 (exactly at default 10) → Lua returns 'ok' (10 > 10 is false)
    mockRedis.eval.mockResolvedValueOnce(['ok', 10, 50]);

    const { reserveSmsCost } = await import('../sms-tracker');
    await expect(reserveSmsCost('biz-001')).resolves.toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
