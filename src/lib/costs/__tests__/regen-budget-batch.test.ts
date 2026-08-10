// src/lib/costs/__tests__/regen-budget-batch.test.ts
//
// T1 EVAL suite for #678 — the batched sibling of `peekRegenBudget` (D-F).
//
// The **Reviews list** needs one per-review counter per ANSWERED row. A
// `Generate` is free by construction (`generate-draft.ts` charges only
// `version > 1`), so unanswered rows are never passed in — one MGET instead of
// N GETs. The authoritative gate stays the worker's Lua INCR
// (`checkRegenBudget`); this is advisory UX only, so it FAILS OPEN: no counter
// renders and every Regenerate button stays enabled.
//
// RED until Task 6 adds `peekRegenBudgetBatch` to `src/lib/costs/tracker.ts`.
// Destructured off a dynamic import so a missing export is `undefined` (a
// per-title TypeError) rather than a module-level ESM link error.

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.REDIS_CACHE_URL = 'redis://localhost:6379';
  process.env.REDIS_CACHE_TOKEN = 'test-token';
  process.env.DAILY_COST_LIMIT_CENTS_COPILOT = '1000';
  process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '2000';
});

// ── Mock Redis ───────────────────────────────────────────────────────────────

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incr: vi.fn(),
  decr: vi.fn(),
  expire: vi.fn(),
  eval: vi.fn(),
  mget: vi.fn(),
  pipeline: vi.fn(),
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
    mget = mockRedis.mget;
    pipeline = mockRedis.pipeline;
  },
}));

vi.mock('@/lib/db/server', () => ({
  sql: vi.fn(),
  jsonb: (v: unknown) => v,
}));

const REVIEW_A = 'rev-aaa';
const REVIEW_B = 'rev-bbb';
const REVIEW_C = 'rev-ccc';

/** `regenBudgetKey` is module-private; mirror its UTC date scoping here. */
function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

interface RegenBudgetStatusShape {
  used: number;
  limit: number;
  remaining: number;
}

async function loadBatchPeek(): Promise<
  (reviewIds: readonly string[]) => Promise<Map<string, RegenBudgetStatusShape>>
> {
  const mod = await import('../tracker');
  return (mod as unknown as {
    peekRegenBudgetBatch: (
      reviewIds: readonly string[],
    ) => Promise<Map<string, RegenBudgetStatusShape>>;
  }).peekRegenBudgetBatch;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('peekRegenBudgetBatch', () => {
  it('peekRegenBudgetBatch returns one status per review id in a single round trip', async () => {
    mockRedis.mget.mockResolvedValueOnce(['2', null, '3']);

    const peekRegenBudgetBatch = await loadBatchPeek();
    const statuses = await peekRegenBudgetBatch([REVIEW_A, REVIEW_B, REVIEW_C]);

    expect(statuses.size).toBe(3);
    expect(statuses.get(REVIEW_A)).toEqual({ used: 2, limit: 3, remaining: 1 });
    // A missing counter is zero used, not "unknown" — the review simply has not
    // been regenerated today.
    expect(statuses.get(REVIEW_B)).toEqual({ used: 0, limit: 3, remaining: 3 });
    expect(statuses.get(REVIEW_C)).toEqual({ used: 3, limit: 3, remaining: 0 });

    // ONE round trip, on the same UTC-date-scoped keys `peekRegenBudget` uses.
    const today = todayDateStr();
    expect(mockRedis.mget).toHaveBeenCalledTimes(1);
    expect(mockRedis.mget).toHaveBeenCalledWith(
      `regen:${REVIEW_A}:${today}`,
      `regen:${REVIEW_B}:${today}`,
      `regen:${REVIEW_C}:${today}`,
    );
    expect(mockRedis.get).not.toHaveBeenCalled();
    // Read-only: rendering a counter must never consume budget or trigger spend.
    expect(mockRedis.incr).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  it('peekRegenBudgetBatch fails open to an empty map when Redis is unavailable', async () => {
    mockRedis.mget.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const peekRegenBudgetBatch = await loadBatchPeek();
    const statuses = await peekRegenBudgetBatch([REVIEW_A, REVIEW_B]);

    // An EMPTY map, not a throw and not zeros: a missing entry means UNKNOWN,
    // so no counter renders and every Regenerate button stays enabled (D-F, F6).
    // Inverting this would disable every Regenerate during an Upstash outage.
    expect(statuses.size).toBe(0);
    expect(statuses.get(REVIEW_A)).toBeUndefined();
  });

  it('peekRegenBudgetBatch never rejects, so no caller needs a catch of its own', async () => {
    const peekRegenBudgetBatch = await loadBatchPeek();

    // Three ways the peek can fail, all of which must resolve rather than throw
    // — this is the whole reason #731 could delete the single-key peek and its
    // caller's try/catch (D-F / D10: the swallow lives HERE, once).
    mockRedis.mget.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(peekRegenBudgetBatch([REVIEW_A])).resolves.toBeInstanceOf(Map);

    mockRedis.mget.mockImplementationOnce(() => {
      throw new Error('synchronous client construction failed');
    });
    await expect(peekRegenBudgetBatch([REVIEW_A])).resolves.toBeInstanceOf(Map);

    // An empty input short-circuits without touching Redis at all.
    mockRedis.mget.mockClear();
    await expect(peekRegenBudgetBatch([])).resolves.toBeInstanceOf(Map);
    expect(mockRedis.mget).not.toHaveBeenCalled();
  });
});
