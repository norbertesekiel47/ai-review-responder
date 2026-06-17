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

// ── Mock DB ──────────────────────────────────────────────────────────

const mockSqlTagged = vi.fn().mockResolvedValue([]);
// Postgres.js uses tagged template syntax: sql`...`
// We mock it as a function that handles both direct calls and tagged templates
vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(mockSqlTagged, {
    apply: (_target, _thisArg, args) => mockSqlTagged(...args),
  }),
  jsonb: (v: unknown) => v,
}));

// ── Mock uuid ────────────────────────────────────────────────────────

vi.mock('uuid', () => ({
  v7: vi.fn().mockReturnValue('00000000-0000-7000-8000-000000000001'),
}));

// ── Tests ────────────────────────────────────────────────────────────

describe('calculateCostUsd', () => {
  it('calculates correctly for gpt-4o-mini', async () => {
    const { calculateCostUsd } = await import('../audit');
    // 1000 input tokens at $0.15/1M + 500 output tokens at $0.60/1M
    const cost = calculateCostUsd('gpt-4o-mini', 1000, 500);
    const expected = (1000 / 1_000_000) * 0.15 + (500 / 1_000_000) * 0.60;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it('calculates correctly for claude-haiku-4-5-20251001', async () => {
    const { calculateCostUsd } = await import('../audit');
    const cost = calculateCostUsd('claude-haiku-4-5-20251001', 1000, 500);
    const expected = (1000 / 1_000_000) * 0.80 + (500 / 1_000_000) * 4.00;
    expect(cost).toBeCloseTo(expected, 6);
  });

  it('throws for unknown model', async () => {
    const { calculateCostUsd } = await import('../audit');
    expect(() => calculateCostUsd('unknown-model', 100, 50)).toThrow(
      'Unknown model for pricing',
    );
  });

  it('rounds to 6 decimal places', async () => {
    const { calculateCostUsd } = await import('../audit');
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
    // Lua EVAL returns ['ok', biz, global] when both increments stay under limits.
    mockRedis.eval.mockResolvedValueOnce(['ok', 15, 15]);

    const { reserveCost } = await import('../tracker');
    const dateStr = await reserveCost('biz-001', 'standard');

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    // biz + global key are the 2 Redis KEYS slots
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    expect(evalArgs[1]).toBe(2);
    expect(evalArgs[2]).toMatch(/^cost:daily:biz-001:/);
    expect(evalArgs[3]).toMatch(/^cost:global:/);
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('throws CostLimitExceededError and rolls back when business limit exceeded', async () => {
    // Lua script returns 'biz_exceeded' after internally rolling back.
    mockRedis.eval.mockResolvedValueOnce(['biz_exceeded', 1001, 50]);

    const { reserveCost, CostLimitExceededError } = await import('../tracker');
    await expect(reserveCost('biz-001', 'standard')).rejects.toThrow(
      CostLimitExceededError,
    );
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('throws GlobalCostLimitExceededError when global limit exceeded', async () => {
    mockRedis.eval.mockResolvedValueOnce(['global_exceeded', 100, 10001]);

    const { reserveCost, GlobalCostLimitExceededError } = await import('../tracker');
    await expect(reserveCost('biz-001', 'standard')).rejects.toThrow(
      GlobalCostLimitExceededError,
    );
  });

  it('throws CostInfraUnavailableError (cause preserved) when the Redis eval round-trip fails', async () => {
    const transport = new Error('ECONNRESET');
    mockRedis.eval.mockRejectedValueOnce(transport);

    const { reserveCost } = await import('../tracker');
    const { CostInfraUnavailableError } = await import('../errors');

    const err = await reserveCost('biz-001', 'standard').catch((e) => e);
    expect(err).toBeInstanceOf(CostInfraUnavailableError);
    expect(err.touchpoint).toBe('reserveCost');
    expect(err.cause).toBe(transport); // original transport error kept for diagnostics
  });
});

describe('finalizeCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.eval.mockResolvedValue('ok');
  });

  it('adjusts by (actual - estimated) using the reservation date', async () => {
    const { finalizeCost } = await import('../tracker');
    await finalizeCost('biz-001', 5, '2025-06-15'); // actual 5, estimated 15 → adjustment -10

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    // numKeys slot
    expect(evalArgs[1]).toBe(2);
    expect(evalArgs[2]).toBe('cost:daily:biz-001:2025-06-15');
    expect(evalArgs[3]).toBe('cost:global:2025-06-15');
    // Adjustment argv is the stringified delta.
    expect(evalArgs[4]).toBe('-10');
    expect(evalArgs[5]).toBe('86400'); // ARGV[2] TTL — mirrors RESERVE
    // No pipeline fallback was issued.
    expect(mockPipeline.incrby).not.toHaveBeenCalled();
  });
});

describe('releaseCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedis.eval.mockResolvedValue('ok');
  });

  it('decrements by pessimistic estimate (15) using the reservation date', async () => {
    const { releaseCost } = await import('../tracker');
    await releaseCost('biz-001', '2025-06-15');

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    expect(evalArgs[1]).toBe(2);
    expect(evalArgs[2]).toBe('cost:daily:biz-001:2025-06-15');
    expect(evalArgs[3]).toBe('cost:global:2025-06-15');
    // Release = negative pessimistic estimate, routed through the same Lua.
    expect(evalArgs[4]).toBe('-15');
    expect(evalArgs[5]).toBe('86400'); // ARGV[2] TTL — mirrors RESERVE
    expect(mockPipeline.decrby).not.toHaveBeenCalled();
  });
});

describe('checkRegenBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows up to 3 regenerations', async () => {
    mockRedis.eval.mockResolvedValueOnce(['ok', 3]);

    const { checkRegenBudget } = await import('../tracker');
    await expect(checkRegenBudget('rev-001')).resolves.toBeUndefined();
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('throws RegenBudgetExceededError on 4th and releases', async () => {
    mockRedis.eval.mockResolvedValueOnce(['exceeded', 4]);

    const { checkRegenBudget, RegenBudgetExceededError } =
      await import('../tracker');
    await expect(checkRegenBudget('rev-001')).rejects.toThrow(
      RegenBudgetExceededError,
    );
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });
});

describe('peekRegenBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports remaining budget from the read-only counter without spending', async () => {
    mockRedis.get.mockResolvedValueOnce('2');

    const { peekRegenBudget } = await import('../tracker');
    const status = await peekRegenBudget('rev-001');

    expect(status).toEqual({ used: 2, limit: 3, remaining: 1 });
    expect(mockRedis.get).toHaveBeenCalledTimes(1);
    // Read-only: must NOT increment the counter or run the budget Lua — surfacing
    // the message can't consume budget or trigger LLM spend (issue #335 AC).
    expect(mockRedis.incr).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('treats a missing counter as zero used (full budget remaining)', async () => {
    mockRedis.get.mockResolvedValueOnce(null);

    const { peekRegenBudget } = await import('../tracker');
    expect(await peekRegenBudget('rev-001')).toEqual({ used: 0, limit: 3, remaining: 3 });
  });

  it('reports zero remaining once the daily cap is reached', async () => {
    mockRedis.get.mockResolvedValueOnce('3');

    const { peekRegenBudget } = await import('../tracker');
    expect(await peekRegenBudget('rev-001')).toEqual({ used: 3, limit: 3, remaining: 0 });
  });
});

describe('recordApiCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sql to insert into api_costs', async () => {
    const { recordApiCost } = await import('../audit');
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

  it('throws CostInfraUnavailableError when the Redis get round-trip fails (NOT treated as a cache miss)', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('ECONNRESET'));

    const { checkIdempotentCache } = await import('../tracker');
    const { CostInfraUnavailableError } = await import('../errors');

    const err = await checkIdempotentCache('rev-001', 1).catch((e) => e);
    expect(err).toBeInstanceOf(CostInfraUnavailableError);
    expect(err.touchpoint).toBe('checkIdempotentCache');
  });
});
