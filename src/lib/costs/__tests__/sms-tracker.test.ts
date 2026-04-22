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
  pipeline: vi.fn().mockReturnValue(mockPipeline),
};

vi.mock('ioredis', () => ({
  default: class MockRedis {
    get = mockRedis.get;
    set = mockRedis.set;
    incr = mockRedis.incr;
    decr = mockRedis.decr;
    expire = mockRedis.expire;
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
    mockPipelineExec
      .mockResolvedValueOnce([[null, 1], [null, 1]])   // incrby results
      .mockResolvedValueOnce([[null, 1], [null, 1]]);  // expire results

    const { reserveSmsCost } = await import('../sms-tracker');
    const dateStr = await reserveSmsCost('biz-001');

    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mockPipeline.incrby).toHaveBeenCalledTimes(2);
    // Confirm the keys and amount
    expect(mockPipeline.incrby).toHaveBeenCalledWith(
      `cost:sms:biz-001:${dateStr}`,
      1,
    );
    expect(mockPipeline.incrby).toHaveBeenCalledWith(
      `cost:sms:global:${dateStr}`,
      1,
    );
    // expire called on both keys
    expect(mockPipeline.expire).toHaveBeenCalledWith(
      `cost:sms:biz-001:${dateStr}`,
      86_400,
    );
    expect(mockPipeline.expire).toHaveBeenCalledWith(
      `cost:sms:global:${dateStr}`,
      86_400,
    );
  });

  it('throws DailySmsLimitExceededError(per_business) and rolls back both counters', async () => {
    // bizTotal 11 (over default 10), global OK
    mockPipelineExec
      .mockResolvedValueOnce([[null, 11], [null, 50]])  // incrby results
      .mockResolvedValueOnce([[null, 10], [null, 49]]); // decrby rollback

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.name).toBe('DailySmsLimitExceededError');
    expect(err.scope).toBe('per_business');

    // Rollback happened — decrby called for both keys
    expect(mockPipeline.decrby).toHaveBeenCalled();
  });

  it('throws DailySmsLimitExceededError(global) when global cap exceeded', async () => {
    // Business under cap, global over default 500
    mockPipelineExec
      .mockResolvedValueOnce([[null, 5], [null, 501]])   // incrby results
      .mockResolvedValueOnce([[null, 4], [null, 500]]);  // decrby rollback

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('global');
    expect(mockPipeline.decrby).toHaveBeenCalled();
  });

  it('auto-rollback on cap exceeded results in net-zero change', async () => {
    mockPipelineExec
      .mockResolvedValueOnce([[null, 11], [null, 50]])   // incrby
      .mockResolvedValueOnce([[null, 10], [null, 49]]);  // decrby rollback

    const { reserveSmsCost } = await import('../sms-tracker');
    await expect(reserveSmsCost('biz-001')).rejects.toThrow();

    // Exactly one incrby pair + one decrby pair → net zero
    expect(mockPipeline.incrby).toHaveBeenCalledTimes(2);
    expect(mockPipeline.decrby).toHaveBeenCalledTimes(2);
  });

  it('does NOT call expire on cap exceeded (avoid TTL side effects on rollback)', async () => {
    mockPipelineExec
      .mockResolvedValueOnce([[null, 11], [null, 50]])
      .mockResolvedValueOnce([[null, 10], [null, 49]]);

    const { reserveSmsCost } = await import('../sms-tracker');
    await expect(reserveSmsCost('biz-001')).rejects.toThrow();
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
    // Going just over the default fallback (10) should trigger per_business cap
    mockPipelineExec
      .mockResolvedValueOnce([[null, 11], [null, 50]])
      .mockResolvedValueOnce([[null, 10], [null, 49]]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('per_business');
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to default 10 when SMS_DAILY_LIMIT_CENTS_PER_BUSINESS is unset', async () => {
    // (already deleted in beforeEach)
    mockPipelineExec
      .mockResolvedValueOnce([[null, 11], [null, 50]])
      .mockResolvedValueOnce([[null, 10], [null, 49]]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('per_business');
  });

  it('uses default global cap 500 when unset', async () => {
    // Business under default 10, global just over 500
    mockPipelineExec
      .mockResolvedValueOnce([[null, 5], [null, 501]])
      .mockResolvedValueOnce([[null, 4], [null, 500]]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('global');
  });

  it('honours a valid SMS_DAILY_LIMIT_CENTS_PER_BUSINESS override', async () => {
    process.env.SMS_DAILY_LIMIT_CENTS_PER_BUSINESS = '3';
    // bizTotal 4 (over override 3) → per_business cap
    mockPipelineExec
      .mockResolvedValueOnce([[null, 4], [null, 50]])
      .mockResolvedValueOnce([[null, 3], [null, 49]]);

    const { reserveSmsCost, DailySmsLimitExceededError } = await import('../sms-tracker');
    const err = await reserveSmsCost('biz-001').catch((e) => e);
    expect(err).toBeInstanceOf(DailySmsLimitExceededError);
    expect(err.scope).toBe('per_business');
  });

  it('allows bizTotal equal to the cap (boundary: cap is inclusive)', async () => {
    // bizTotal 10 (exactly at default 10) → should NOT throw
    mockPipelineExec
      .mockResolvedValueOnce([[null, 10], [null, 50]])
      .mockResolvedValueOnce([[null, 1], [null, 1]]);

    const { reserveSmsCost } = await import('../sms-tracker');
    await expect(reserveSmsCost('biz-001')).resolves.toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
