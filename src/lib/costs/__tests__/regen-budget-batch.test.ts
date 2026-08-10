// src/lib/costs/__tests__/regen-budget-batch.test.ts
//
// T1 EVAL suite for #678 — the batched advisory peek (D-F). Since #731 deleted
// the single-key sibling it is the ONLY advisory peek, so this suite owns the
// whole used/limit/remaining derivation as well as the fail-open contract.
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

// Capture the swallow-and-log payload. #731 moved this warn OUT of
// `enforceRegenBudgetForReview` and into `peekRegenBudgetBatch`, so this suite is
// now the only place the logging-privacy contract can be observed — the enforcer
// suite mocks this whole module away and can no longer see a log at all.
const mockWarn = vi.fn();
vi.mock('@/lib/shared/logger', () => ({
  createWorkerLogger: () => ({ log: vi.fn(), warn: mockWarn, error: vi.fn() }),
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

    // ONE round trip, on UTC-date-scoped keys the worker's Lua INCR shares.
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

  it('the peek-failure warn carries subject_count and never a review id', async () => {
    // The logging-privacy pin (CLAUDE.md → Structured logging: never log raw
    // review/response text or ids). It lives HERE, not in
    // dashboard-regen-rate-limit.test.ts: post-#731 the enforcer emits no log of
    // its own and that suite replaces this whole module with a `vi.fn`, so its
    // former `never leaks the raw review id` title could not observe a warn for
    // ANY implementation and was deleted rather than left permanently vacuous.
    //
    // Asserted UNCONDITIONALLY — no `if (mockWarn.mock.calls.length > 0)` guard.
    // A privacy assertion must fail loudly when its subject moves again, which is
    // exactly the signal a guarded version suppresses.
    mockRedis.mget.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const peekRegenBudgetBatch = await loadBatchPeek();
    await peekRegenBudgetBatch([REVIEW_A, REVIEW_B]);

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const logged = mockWarn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged.event).toBe('regen_budget_peek_failed');
    expect(logged.peek).toBe('batch');
    // The COUNT is what discriminates the route's single-id call from a
    // page-sized batch — the ids themselves are never the observability payload.
    // Adding a `review_ids` field, or folding ids into `reason`, fails here.
    expect(logged.subject_count).toBe(2);
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain(REVIEW_A);
    expect(serialized).not.toContain(REVIEW_B);
    // `reason` is the provider error's message VERBATIM — that is the payload's
    // sanitization boundary, pinned so it is a visible decision rather than an
    // assumption. The four keys above are everything this code constructs, so an
    // id can only ever arrive from inside `err.message`.
    expect(logged.reason).toBe('ECONNREFUSED');
    expect(Object.keys(logged).sort()).toEqual(['event', 'peek', 'reason', 'subject_count']);
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

  // ── #731 item 3: the used/limit/remaining derivation, absorbed from the
  // deleted single-key peek's suite. `tracker.test.ts`'s mockRedis has no
  // `mget`, so these two cases cannot live there — they moved here BEFORE the
  // single-key peek and its describe block were deleted.

  it('treats a missing counter as zero used, so a full budget remains', async () => {
    const peekRegenBudgetBatch = await loadBatchPeek();
    mockRedis.mget.mockResolvedValueOnce([null]);

    const statuses = await peekRegenBudgetBatch([REVIEW_A]);

    // An absent KEY means unused. Only an absent MAP ENTRY means the peek
    // failed — the distinction the whole fail-open posture rests on.
    expect(statuses.get(REVIEW_A)).toEqual({ used: 0, limit: 3, remaining: 3 });
  });

  it('reports zero remaining once the per-review daily cap is reached', async () => {
    const peekRegenBudgetBatch = await loadBatchPeek();
    mockRedis.mget.mockResolvedValueOnce(['3']);

    const statuses = await peekRegenBudgetBatch([REVIEW_A]);

    expect(statuses.get(REVIEW_A)).toEqual({ used: 3, limit: 3, remaining: 0 });
    // Read-only: surfacing "limit reached" must consume no budget and trigger
    // no LLM spend (issue #335 AC), so neither the counter nor the Lua runs.
    expect(mockRedis.incr).not.toHaveBeenCalled();
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
});
