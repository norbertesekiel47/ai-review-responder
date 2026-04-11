import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

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

// ── Mock DB ──────────────────────────────────────────────────────────

const mockSqlTagged = vi.fn().mockResolvedValue([]);
// Postgres.js uses tagged template syntax: sql`...`
// We mock it as a function that handles both direct calls and tagged templates
vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(mockSqlTagged, {
    apply: (_target, _thisArg, args) => mockSqlTagged(...args),
  }),
}));

// ── Mock uuid ────────────────────────────────────────────────────────

vi.mock('uuid', () => ({
  v7: vi.fn().mockReturnValue('00000000-0000-7000-8000-000000000001'),
}));

// ── Tests ────────────────────────────────────────────────────────────

describe('calculateCostUsd', () => {
  it('calculates correctly for gpt-4o-mini', async () => {
    const { calculateCostUsd } = await import('../tracker');
    // 1000 input tokens at $0.15/1M + 500 output tokens at $0.60/1M
    const cost = calculateCostUsd('gpt-4o-mini', 1000, 500);
    const expected = (1000 / 1_000_000) * 0.15 + (500 / 1_000_000) * 0.60;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it('calculates correctly for claude-haiku-4-5-20251001', async () => {
    const { calculateCostUsd } = await import('../tracker');
    const cost = calculateCostUsd('claude-haiku-4-5-20251001', 1000, 500);
    const expected = (1000 / 1_000_000) * 0.80 + (500 / 1_000_000) * 4.00;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it('throws for unknown model', async () => {
    const { calculateCostUsd } = await import('../tracker');
    expect(() => calculateCostUsd('unknown-model', 100, 50)).toThrow(
      'Unknown model for pricing',
    );
  });

  it('rounds to 6 decimal places', async () => {
    const { calculateCostUsd } = await import('../tracker');
    const cost = calculateCostUsd('gpt-4o-mini', 1, 1);
    const decimals = cost.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});

describe('reserveCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipeline.incrby.mockReturnThis();
    mockPipeline.decrby.mockReturnThis();
    mockPipeline.expire.mockReturnThis();
  });

  it('increments both business and global keys and returns date string', async () => {
    mockPipelineExec
      .mockResolvedValueOnce([[null, 15], [null, 15]])   // incrby results
      .mockResolvedValueOnce([[null, 1], [null, 1]]);    // expire results

    const { reserveCost } = await import('../tracker');
    const dateStr = await reserveCost('biz-001', 'standard');

    expect(mockPipeline.incrby).toHaveBeenCalledTimes(2);
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('throws CostLimitExceededError and rolls back when business limit exceeded', async () => {
    // Simulate business total = 1001 (over 1000 standard limit)
    mockPipelineExec
      .mockResolvedValueOnce([[null, 1001], [null, 50]])  // incrby results
      .mockResolvedValueOnce([[null, 1], [null, 1]]);     // decrby rollback

    const { reserveCost, CostLimitExceededError } = await import('../tracker');
    await expect(reserveCost('biz-001', 'standard')).rejects.toThrow(
      CostLimitExceededError,
    );

    // Should have called decrby to rollback
    expect(mockPipeline.decrby).toHaveBeenCalled();
  });

  it('throws GlobalCostLimitExceededError when global limit exceeded', async () => {
    // Business OK, global over
    mockPipelineExec
      .mockResolvedValueOnce([[null, 100], [null, 10001]])  // incrby results
      .mockResolvedValueOnce([[null, 1], [null, 1]]);        // decrby rollback

    const { reserveCost, GlobalCostLimitExceededError } = await import('../tracker');
    await expect(reserveCost('biz-001', 'standard')).rejects.toThrow(
      GlobalCostLimitExceededError,
    );
  });
});

describe('acquireConcurrencySlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquires slot when under limit', async () => {
    mockRedis.incr.mockResolvedValueOnce(1);
    mockRedis.expire.mockResolvedValueOnce(1);

    const { acquireConcurrencySlot } = await import('../tracker');
    await expect(acquireConcurrencySlot('biz-001')).resolves.toBeUndefined();
  });

  it('throws ConcurrencyLimitExceededError at max+1 and releases', async () => {
    mockRedis.incr.mockResolvedValueOnce(4); // over limit of 3
    mockRedis.decr.mockResolvedValueOnce(3);

    const { acquireConcurrencySlot, ConcurrencyLimitExceededError } =
      await import('../tracker');
    await expect(acquireConcurrencySlot('biz-001')).rejects.toThrow(
      ConcurrencyLimitExceededError,
    );
    expect(mockRedis.decr).toHaveBeenCalled();
  });
});

describe('finalizeCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipeline.incrby.mockReturnThis();
    mockPipelineExec.mockResolvedValueOnce([[null, 1], [null, 1]]);
  });

  it('adjusts by (actual - estimated) using the reservation date', async () => {
    const { finalizeCost } = await import('../tracker');
    await finalizeCost('biz-001', 5, '2025-06-15'); // actual 5, estimated 15 → adjustment -10

    // incrby with -10 on the SAME date as reservation
    expect(mockPipeline.incrby).toHaveBeenCalledWith(
      'cost:daily:biz-001:2025-06-15',
      -10,
    );
    expect(mockPipeline.incrby).toHaveBeenCalledWith(
      'cost:global:2025-06-15',
      -10,
    );
  });
});

describe('releaseCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPipeline.decrby.mockReturnThis();
    mockPipelineExec.mockResolvedValueOnce([[null, 1], [null, 1]]);
  });

  it('decrements by pessimistic estimate (15) using the reservation date', async () => {
    const { releaseCost } = await import('../tracker');
    await releaseCost('biz-001', '2025-06-15');

    expect(mockPipeline.decrby).toHaveBeenCalledWith(
      'cost:daily:biz-001:2025-06-15',
      15,
    );
    expect(mockPipeline.decrby).toHaveBeenCalledWith(
      'cost:global:2025-06-15',
      15,
    );
  });
});

describe('releaseConcurrencySlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('decrements and floors at 0', async () => {
    mockRedis.decr.mockResolvedValueOnce(-1);
    mockRedis.set.mockResolvedValueOnce('OK');

    const { releaseConcurrencySlot } = await import('../tracker');
    await releaseConcurrencySlot('biz-001');

    expect(mockRedis.decr).toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('gen:active:biz-001'),
      '0',
    );
  });
});

describe('checkRegenBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows up to 3 regenerations', async () => {
    mockRedis.incr.mockResolvedValueOnce(3);
    mockRedis.expire.mockResolvedValueOnce(1);

    const { checkRegenBudget } = await import('../tracker');
    await expect(checkRegenBudget('rev-001')).resolves.toBeUndefined();
  });

  it('throws RegenBudgetExceededError on 4th and releases', async () => {
    mockRedis.incr.mockResolvedValueOnce(4);
    mockRedis.decr.mockResolvedValueOnce(3);
    mockRedis.expire.mockResolvedValueOnce(1);

    const { checkRegenBudget, RegenBudgetExceededError } =
      await import('../tracker');
    await expect(checkRegenBudget('rev-001')).rejects.toThrow(
      RegenBudgetExceededError,
    );
    expect(mockRedis.decr).toHaveBeenCalled();
  });
});

describe('recordApiCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sql to insert into api_costs', async () => {
    const { recordApiCost } = await import('../tracker');
    await recordApiCost({
      businessId: 'biz-001',
      provider: 'openai',
      endpoint: 'chat.completions',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.000_045,
      responseId: null,
    });

    expect(mockSqlTagged).toHaveBeenCalled();
  });
});

describe('checkIdempotentCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cached value when present', async () => {
    mockRedis.get.mockResolvedValueOnce('{"responseText":"cached"}');

    const { checkIdempotentCache } = await import('../tracker');
    const result = await checkIdempotentCache('rev-001', 1);
    expect(result).toBe('{"responseText":"cached"}');
  });

  it('returns null when not cached', async () => {
    mockRedis.get.mockResolvedValueOnce(null);

    const { checkIdempotentCache } = await import('../tracker');
    const result = await checkIdempotentCache('rev-001', 1);
    expect(result).toBeNull();
  });
});
