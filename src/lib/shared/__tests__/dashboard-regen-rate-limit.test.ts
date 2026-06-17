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

// The per-review budget peek is exercised in isolation here — its Redis math is
// covered by tracker.test.ts. We drive the enforcer's threshold + fail-open
// behavior directly.
const mockPeekRegenBudget = vi.fn();
vi.mock('@/lib/costs/tracker', () => ({
  peekRegenBudget: (...args: unknown[]) => mockPeekRegenBudget(...args),
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
    mockEval.mockResolvedValueOnce(6).mockResolvedValueOnce(1); // burst 6 > 5

    const result = await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(result).toBeInstanceOf(NextResponse);
    expect(result?.status).toBe(429);
    expect(result?.headers.get('Cache-Control')).toBe('no-store, private');
    expect(await result?.json()).toEqual({ error: 'rate_limited' });
  });

  it('returns 429 when the hour window is over limit even though burst is fine', async () => {
    mockEval.mockResolvedValueOnce(1).mockResolvedValueOnce(31); // hour 31 > 30

    const result = await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(result?.status).toBe(429);
  });

  it('still increments BOTH windows when the burst layer is already over limit', async () => {
    // No early return may skip the hour counter — both layers must advance so
    // a blocked burst window does not desync the sustained window.
    mockEval.mockResolvedValueOnce(6).mockResolvedValueOnce(2);

    await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(mockEval).toHaveBeenCalledTimes(2);
  });

  it('FAILS OPEN: allows the request (returns null) when Redis errors', async () => {
    mockEval.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await enforceDashboardRegenRateLimit(ACCOUNT_ID);

    expect(result).toBeNull(); // default (non-strict) checkRateLimit fail-open
  });

  it('emits exactly ONE structured warn log with a hashed account id (never the raw id) on block', async () => {
    mockEval.mockResolvedValueOnce(6).mockResolvedValueOnce(1); // burst over

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

  it('returns null (allows) when regenerations remain', async () => {
    mockPeekRegenBudget.mockResolvedValue({ used: 1, limit: 3, remaining: 2 });

    expect(await enforceRegenBudgetForReview(REVIEW_ID)).toBeNull();
  });

  it('returns a 429 regen_limit_reached no-store response when the daily cap is reached', async () => {
    mockPeekRegenBudget.mockResolvedValue({ used: 3, limit: 3, remaining: 0 });

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

  it('FAILS OPEN: returns null when the budget peek throws (worker stays the gate)', async () => {
    mockPeekRegenBudget.mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await enforceRegenBudgetForReview(REVIEW_ID)).toBeNull();
  });

  it('never leaks the raw review id into the fail-open log', async () => {
    mockPeekRegenBudget.mockRejectedValue(new Error('ECONNREFUSED'));

    await enforceRegenBudgetForReview(REVIEW_ID);

    if (mockWarn.mock.calls.length > 0) {
      const logged = mockWarn.mock.calls[0]?.[0];
      expect(JSON.stringify(logged)).not.toContain(REVIEW_ID);
    }
  });
});
