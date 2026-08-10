import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// Drive checkRateLimit's atomic INCR return value by mocking the cache Redis.
// The helper is exercised THROUGH the real checkRateLimit so the test also
// proves it does NOT opt into strict mode (fail-open) and uses distinct keys.
const mockEval = vi.fn();
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ eval: mockEval }),
}));

// Capture the single structured log line emitted on a block.
const mockWarn = vi.fn();
vi.mock('@/lib/shared/logger', () => ({
  createWorkerLogger: () => ({ log: vi.fn(), warn: mockWarn, error: vi.fn() }),
}));

// The per-review daily cap peek is exercised in isolation here — its Redis math
// and its swallow-and-log live in src/lib/costs/__tests__/regen-budget-batch.test.ts.
// #731: the enforcer now calls the BATCHED peek, which never rejects, so an
// ABSENT MAP ENTRY (not a rejection) is the fail-open signal.
const mockPeekRegenBudgetBatch = vi.fn();
vi.mock('@/lib/costs/tracker', () => ({
  peekRegenBudgetBatch: (...args: unknown[]) => mockPeekRegenBudgetBatch(...args),
}));

import {
  enforceDashboardRegenRateLimit,
  enforceRegenBudgetForReview,
} from '../dashboard-regen-rate-limit';

const ACCOUNT_ID = 'a0000000-0000-7000-8000-000000000001';

// checkRateLimit calls redis.eval(LUA, 1, key, String(windowSeconds)),
// so call[2] is the Redis key and call[3] is the window in seconds.
function evalKeys(): string[] {
  return mockEval.mock.calls.map((c) => c[2] as string);
}
function evalWindows(): string[] {
  return mockEval.mock.calls.map((c) => c[3] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  // checkRateLimit short-circuits to allowed when this is unset, which would
  // bypass the Redis path entirely — set it so eval() is actually consulted.
  process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0';
});

describe('enforceDashboardRegenRateLimit', () => {
  it('increments two INDEPENDENT keys (:burst and :hour) exactly once each per request', async () => {
    mockEval.mockResolvedValue(1); // first hit in each window

    const result = await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(result).toBeNull();
    // One INCR per layer — not a single shared counter double-incremented.
    expect(mockEval).toHaveBeenCalledTimes(2);
    const keys = evalKeys();
    expect(keys).toEqual([
      `dashregen:owner:${ACCOUNT_ID}:burst`,
      `dashregen:owner:${ACCOUNT_ID}:hour`,
    ]);
    expect(new Set(keys).size).toBe(2); // distinct keys
    expect(evalWindows()).toEqual(['60', '3600']); // 60s burst, 3600s hour
  });

  it('returns a 429 no-store response when the burst window is over limit', async () => {
    mockEval.mockResolvedValueOnce(11).mockResolvedValueOnce(1); // burst 11 > 10

    const result = await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(result).toBeInstanceOf(NextResponse);
    expect(result?.status).toBe(429);
    expect(result?.headers.get('Cache-Control')).toBe('no-store, private');
    expect(await result?.json()).toEqual({ error: 'rate_limited' });
  });

  it('allows the 10th burst request and the 30th hour request — the #672 policy limits, pinned from the allowed side', async () => {
    // Pins BURST_MAX=10 / HOUR_MAX=30 at the boundary. The over-limit tests
    // alone cannot catch a limit that drifts UPWARD, which is the direction
    // that quietly widens an owner-controlled LLM spend surface (#672 G2).
    mockEval.mockResolvedValueOnce(10).mockResolvedValueOnce(30);

    await expect(enforceDashboardRegenRateLimit(ACCOUNT_ID)).resolves.toBeNull();
  });

  it('returns 429 when the hour window is over limit even though burst is fine', async () => {
    mockEval.mockResolvedValueOnce(1).mockResolvedValueOnce(31); // hour 31 > 30

    const result = await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(result?.status).toBe(429);
  });

  it('still increments BOTH windows when the burst layer is already over limit', async () => {
    // No early return may skip the hour counter — both layers must advance so
    // a blocked burst window does not desync the sustained window.
    mockEval.mockResolvedValueOnce(11).mockResolvedValueOnce(2);

    await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(mockEval).toHaveBeenCalledTimes(2);
  });

  it('FAILS OPEN: allows the request (returns null) when Redis errors', async () => {
    mockEval.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(result).toBeNull(); // default (non-strict) checkRateLimit fail-open
  });

  it('emits exactly ONE structured warn log with a hashed account id (never the raw id) on block', async () => {
    mockEval.mockResolvedValueOnce(11).mockResolvedValueOnce(1); // burst over

    await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const logged = mockWarn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged.event).toBe('rate_limit_exceeded');
    expect(logged.route).toBe('dashboard_regenerate');
    expect(logged.window).toBe('burst_60s');
    expect(typeof logged.acctHash).toBe('string');
    expect(logged.acctHash).not.toBe(ACCOUNT_ID);
    // The raw account id must never appear anywhere in the log payload.
    expect(JSON.stringify(logged)).not.toContain(ACCOUNT_ID);
  });

  it('labels the log window hour_3600s when only the hour layer is over limit', async () => {
    mockEval.mockResolvedValueOnce(1).mockResolvedValueOnce(31);

    await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect((mockWarn.mock.calls[0]?.[0] as Record<string, unknown>).window).toBe('hour_3600s');
  });

  it('does not log when the request is allowed', async () => {
    mockEval.mockResolvedValue(1);

    await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe('enforceRegenBudgetForReview', () => {
  const REVIEW_ID = 'rev-001';

  it('enforceRegenBudgetForReview proceeds when the batched peek reports remaining above zero', async () => {
    mockPeekRegenBudgetBatch.mockResolvedValue(
      new Map([[REVIEW_ID, { used: 1, limit: 3, remaining: 2 }]]),
    );

    expect(await enforceRegenBudgetForReview(REVIEW_ID)).toBeNull();
    expect(mockPeekRegenBudgetBatch).toHaveBeenCalledWith([REVIEW_ID]);
  });

  it('enforceRegenBudgetForReview returns 429 regen_limit_reached when the batched peek reports zero remaining', async () => {
    mockPeekRegenBudgetBatch.mockResolvedValue(
      new Map([[REVIEW_ID, { used: 3, limit: 3, remaining: 0 }]]),
    );

    const result = await enforceRegenBudgetForReview(REVIEW_ID);

    expect(result).toBeInstanceOf(NextResponse);
    expect(result?.status).toBe(429);
    expect(result?.headers.get('Cache-Control')).toBe('no-store, private');
    const body = await result?.json();
    expect(body.error).toBe('regen_limit_reached');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.remaining).toBe(0);
    expect(body.limit).toBe(3);
  });

  it('enforceRegenBudgetForReview proceeds when the batched peek returns no entry for the review', async () => {
    // The ONLY fail-open path after #731. An absent MAP ENTRY means the MGET
    // itself failed, so the advisory peek is UNKNOWN. Distinct from an absent
    // Redis KEY, which still yields `{ used: 0 }` — inverting the two would 429
    // every regenerate during an Upstash outage. The authoritative gate is
    // unaffected: the worker's Lua INCR still refuses over-budget work (D-F).
    mockPeekRegenBudgetBatch.mockResolvedValue(new Map());

    expect(await enforceRegenBudgetForReview(REVIEW_ID)).toBeNull();
    // Pins that the null came from the BATCHED peek's absent entry, not from
    // some other path that also returns null (deviation D3(c): before the
    // rewire this title was green because a swallowed TypeError also returned
    // null, so `toBeNull()` alone cannot tell the two apart).
    expect(mockPeekRegenBudgetBatch).toHaveBeenCalledWith([REVIEW_ID]);
  });

  it('never leaks the raw review id into the fail-open log', async () => {
    mockPeekRegenBudgetBatch.mockResolvedValue(new Map());

    await enforceRegenBudgetForReview(REVIEW_ID);

    if (mockWarn.mock.calls.length > 0) {
      const logged = mockWarn.mock.calls[0]?.[0];
      expect(JSON.stringify(logged)).not.toContain(REVIEW_ID);
    }
  });
});
