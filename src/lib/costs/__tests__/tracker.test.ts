import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import fc from 'fast-check';
import type { Sql } from 'postgres';

// Set env vars BEFORE any tracker imports trigger getCacheRedisOptions()
beforeAll(() => {
  process.env.REDIS_CACHE_URL = 'redis://localhost:6379';
  process.env.REDIS_CACHE_TOKEN = 'test-token';
  process.env.DAILY_COST_LIMIT_CENTS_COPILOT = '1000';
  process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '2000';
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
  del: vi.fn(),
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
    del = mockRedis.del;
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
    const dateStr = await reserveCost('biz-001', 'copilot');

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    // biz + global key are the 2 Redis KEYS slots
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    expect(evalArgs[1]).toBe(2);
    expect(evalArgs[2]).toMatch(/^cost:daily:biz-001:/);
    expect(evalArgs[3]).toMatch(/^cost:global:/);
    expect(dateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // A configured per-tier + global limit must reach
  // the Lua reservation as the bizLimit/globalLimit ARGV — proving getServerConfig()
  // DRIVES the limits (not just the defaults) after the config migration.
  // ARGV order: [LUA, 2(keys), bizKey, globalKey, estimate, bizLimit, globalLimit, ttl].
  it('passes config-driven Copilot + global limits to the reservation script', async () => {
    process.env.DAILY_COST_LIMIT_CENTS_COPILOT = '250';
    process.env.GLOBAL_DAILY_COST_LIMIT_CENTS = '9999';
    const { resetServerConfigForTests } = await import('@/lib/config/server');
    resetServerConfigForTests();
    try {
      mockRedis.eval.mockResolvedValueOnce(['ok', 15, 15]);
      const { reserveCost } = await import('../tracker');
      await reserveCost('biz-001', 'copilot');
      const evalArgs = mockRedis.eval.mock.calls[0]!;
      expect(evalArgs[5]).toBe('250'); // Copilot limit from config
      expect(evalArgs[6]).toBe('9999'); // global limit from config
    } finally {
      process.env.DAILY_COST_LIMIT_CENTS_COPILOT = '1000';
      delete process.env.GLOBAL_DAILY_COST_LIMIT_CENTS;
      resetServerConfigForTests();
    }
  });

  it('reads the independent Autopilot limit without a price-variant mapping', async () => {
    process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '321';
    const { resetServerConfigForTests } = await import('@/lib/config/server');
    resetServerConfigForTests();
    try {
      mockRedis.eval.mockResolvedValueOnce(['ok', 15, 15]);
      const { reserveCost } = await import('../tracker');
      await reserveCost('biz-001', 'autopilot');
      const evalArgs = mockRedis.eval.mock.calls[0]!;
      expect(evalArgs[5]).toBe('321');
    } finally {
      process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '2000';
      resetServerConfigForTests();
    }
  });

  it('throws CostLimitExceededError and rolls back when business limit exceeded', async () => {
    // Lua script returns 'biz_exceeded' after internally rolling back.
    mockRedis.eval.mockResolvedValueOnce(['biz_exceeded', 1001, 50]);

    const { reserveCost, CostLimitExceededError } = await import('../tracker');
    await expect(reserveCost('biz-001', 'copilot')).rejects.toThrow(
      CostLimitExceededError,
    );
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
  });

  it('throws GlobalCostLimitExceededError when global limit exceeded', async () => {
    mockRedis.eval.mockResolvedValueOnce(['global_exceeded', 100, 10001]);

    const { reserveCost, GlobalCostLimitExceededError } = await import('../tracker');
    await expect(reserveCost('biz-001', 'copilot')).rejects.toThrow(
      GlobalCostLimitExceededError,
    );
  });

  it('throws CostInfraUnavailableError (cause preserved) when the Redis eval round-trip fails', async () => {
    const transport = new Error('ECONNRESET');
    mockRedis.eval.mockRejectedValueOnce(transport);

    const { reserveCost } = await import('../tracker');
    const { CostInfraUnavailableError } = await import('../errors');

    const err = await reserveCost('biz-001', 'copilot').catch((e) => e);
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

describe('task-scoped estimate threading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ARGV layout reminder — eval(LUA, numKeys, bizKey, globalKey, argv...):
  // calls[i][4] is the first ARGV (estimate on reserve, adjustment on
  // finalize/release), calls[i][5] the second.
  it('reserves, finalizes, and releases with the same task-scoped estimate', async () => {
    const { reserveCost, finalizeCost, releaseCost } = await import('../tracker');

    // Reserve at 1¢ — the Lua estimate ARGV must be 1, NOT the 15¢ default.
    mockRedis.eval.mockResolvedValueOnce(['ok', 1, 1]);
    const dateStr = await reserveCost('biz-001', 'copilot', 1);
    expect(mockRedis.eval.mock.calls[0]![4]).toBe('1');

    // Finalize with actual 0 against the SAME 1¢ estimate → adjustment -1
    // (integer cents only; callers round via Math.ceil(usd * 100)).
    mockRedis.eval.mockResolvedValueOnce('ok');
    await finalizeCost('biz-001', 0, dateStr, 1);
    expect(mockRedis.eval.mock.calls[1]![4]).toBe('-1');

    // Release with the SAME 1¢ estimate → -1, not -15.
    mockRedis.eval.mockResolvedValueOnce('ok');
    await releaseCost('biz-001', dateStr, 1);
    expect(mockRedis.eval.mock.calls[2]![4]).toBe('-1');
  });

  it('omitted estimate keeps the 15¢ pessimistic default everywhere (existing-caller regression)', async () => {
    const { reserveCost, finalizeCost, releaseCost } = await import('../tracker');

    mockRedis.eval.mockResolvedValueOnce(['ok', 15, 15]);
    const dateStr = await reserveCost('biz-001', 'copilot');
    expect(mockRedis.eval.mock.calls[0]![4]).toBe('15');

    mockRedis.eval.mockResolvedValueOnce('ok');
    await finalizeCost('biz-001', 5, dateStr);
    expect(mockRedis.eval.mock.calls[1]![4]).toBe('-10');

    mockRedis.eval.mockResolvedValueOnce('ok');
    await releaseCost('biz-001', dateStr);
    expect(mockRedis.eval.mock.calls[2]![4]).toBe('-15');
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

describe('checkAskRegenBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fresh charge markers claim successfully unless a test narrows this.
    mockRedis.set.mockResolvedValue('OK');
    mockRedis.del.mockResolvedValue(1);
  });

  it('throws RegenBudgetExceededError on the 4th distinct regeneration for one askId', async () => {
    mockRedis.eval
      .mockResolvedValueOnce(['ok', 1])
      .mockResolvedValueOnce(['ok', 2])
      .mockResolvedValueOnce(['ok', 3])
      .mockResolvedValueOnce(['exceeded', 4]);

    const { checkAskRegenBudget, RegenBudgetExceededError } =
      await import('../tracker');

    await expect(checkAskRegenBudget('ask-001', 'ob-1')).resolves.toBeUndefined();
    await checkAskRegenBudget('ask-001', 'ob-2');
    await checkAskRegenBudget('ask-001', 'ob-3');
    await expect(checkAskRegenBudget('ask-001', 'ob-4')).rejects.toThrow(
      RegenBudgetExceededError,
    );

    // Key + TTL contract: regen:ask:{askId}:{date}, 86400s TTL, shared
    // 3-per-day limit — same Lua primitive as checkRegenBudget.
    const evalArgs = mockRedis.eval.mock.calls[0]!;
    expect(evalArgs[1]).toBe(1);
    expect(evalArgs[2]).toMatch(/^regen:ask:ask-001:\d{4}-\d{2}-\d{2}$/);
    expect(evalArgs[3]).toBe('3');
    expect(evalArgs[4]).toBe('86400');

    // Marker contract: one SET NX claim per logical request, 24h TTL.
    expect(mockRedis.set).toHaveBeenCalledWith(
      'regen:ask:ask-001:charge:ob-1',
      '1',
      'EX',
      86_400,
      'NX',
    );
  });

  it('replayed attempts of one logical regeneration consume one budget unit', async () => {
    // First processor attempt claims the marker and charges; the BullMQ
    // retries after transient failures find the marker and charge nothing.
    mockRedis.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockRedis.eval.mockResolvedValueOnce(['ok', 1]);

    const { checkAskRegenBudget } = await import('../tracker');

    await checkAskRegenBudget('ask-001', 'ob-1');
    await checkAskRegenBudget('ask-001', 'ob-1');
    await checkAskRegenBudget('ask-001', 'ob-1');

    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    expect(mockRedis.set).toHaveBeenCalledTimes(3);
  });

  it('releases the charge marker when the budget refuses the claim', async () => {
    mockRedis.eval.mockResolvedValueOnce(['exceeded', 4]);

    const { checkAskRegenBudget, RegenBudgetExceededError } =
      await import('../tracker');

    await expect(checkAskRegenBudget('ask-001', 'ob-9')).rejects.toThrow(
      RegenBudgetExceededError,
    );
    expect(mockRedis.del).toHaveBeenCalledWith('regen:ask:ask-001:charge:ob-9');
  });

  it('wraps a marker-claim transport failure as retryable CostInfraUnavailableError', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('ECONNRESET'));

    const { checkAskRegenBudget } = await import('../tracker');
    const { CostInfraUnavailableError } = await import('../errors');

    await expect(checkAskRegenBudget('ask-001', 'ob-1')).rejects.toThrow(
      CostInfraUnavailableError,
    );
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('wraps a budget-Lua transport failure as retryable CostInfraUnavailableError', async () => {
    // A raw Redis transport rejection from the INCR-with-cap Lua must never
    // surface as a permanent failure — the failed hook keeps
    // CostInfraUnavailableError watchdog-eligible.
    mockRedis.eval.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    const { checkAskRegenBudget } = await import('../tracker');
    const { CostInfraUnavailableError } = await import('../errors');

    await expect(checkAskRegenBudget('ask-001', 'ob-1')).rejects.toThrow(
      CostInfraUnavailableError,
    );
  });
});

// #731: the single-key advisory peek was deleted (one caller, nothing varying
// behind it, and the OPPOSITE failure contract to the batched one). Its three
// cases now live in regen-budget-batch.test.ts, which is the only suite whose
// mockRedis has `mget`.

describe('recordApiCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls sql to insert into api_costs', async () => {
    const { recordApiCost } = await import('../audit');
    await recordApiCost(mockSqlTagged as unknown as Sql, {
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

// Property tests (fast-check): the house style for invariant-level coverage —
// see src/lib/reviews/__tests__/sentiment.test.ts "invariants" block.
describe('cost reservation invariants', () => {
  it('reserve followed by release restores the daily counters for any estimate', async () => {
    const { reserveCost, releaseCost } = await import('../tracker');

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), async (estimate) => {
        // mockReset (not clearAllMocks): also drops any leftover
        // mockResolvedValueOnce queue that would bypass the model below.
        mockRedis.eval.mockReset();
        // In-memory counter model of the two Lua scripts: both apply their
        // first ARGV as a signed delta to the biz + global keys.
        const counters = new Map<string, number>();
        mockRedis.eval.mockImplementation(
          async (
            script: string,
            _numKeys: number,
            bizKey: string,
            globalKey: string,
            firstArgv: string,
          ) => {
            const delta = Number(firstArgv);
            counters.set(bizKey, (counters.get(bizKey) ?? 0) + delta);
            counters.set(globalKey, (counters.get(globalKey) ?? 0) + delta);
            return script.includes('bizLimit')
              ? ['ok', counters.get(bizKey)!, counters.get(globalKey)!]
              : 'ok';
          },
        );

        const dateStr = await reserveCost('biz-prop', 'copilot', estimate);
        await releaseCost('biz-prop', dateStr, estimate);

        expect(counters.get(`cost:daily:biz-prop:${dateStr}`)).toBe(0);
        expect(counters.get(`cost:global:${dateStr}`)).toBe(0);
      }),
    );

    // Don't leak the in-memory model into any later suite.
    mockRedis.eval.mockReset();
  });
});
