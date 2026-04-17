import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockRequireRole,
  mockSqlResults,
  sqlCallCounter,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/db/server', () => {
  const sqlProxy = new Proxy(() => {}, {
    apply: (_target, _thisArg, argumentsList) => {
      // Distinguish tagged-template calls from helper calls like sql(idsArray).
      // Tagged template: first arg is a TemplateStringsArray (has .raw).
      // Helper call: first arg is a plain array or value — used for IN clauses.
      // Only tagged-template calls are real queries; return a sentinel for helpers
      // and don't consume a queue slot.
      const first = argumentsList[0];
      const isTaggedTemplate =
        first != null && typeof first === 'object' && 'raw' in (first as object);
      if (!isTaggedTemplate) {
        return { __helper: true };
      }
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }) as unknown;
  return { sql: sqlProxy };
});

// ── Helpers ─────────────────────────────────────────────────────────

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`);
}

// Query sequence (matches src/app/api/admin/costs/route.ts):
//  Detail-only (days <= 90): 4 queries + 1 name-fetch = 5 total
//  Detail + rollup (days > 90): 4 detail + 3 rollup + 1 name-fetch = 8 total
//
//  1. byProvider         (detail aggregate)
//  2. detailBusiness     (detail aggregate by business_id — no JOIN, no pagination)
//  3. byDay              (detail aggregate by date)
//  4. today              (detail sum of today's cost)
//  5. rollupProvider     (only if days > 90)
//  6. rollupDay          (only if days > 90)
//  7. rollupBusiness     (only if days > 90)
//  Last. pageBusinesses  (fetches name + tier for paginated IDs — only if any)

function queueDetailOnlyResults(): void {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  // 1. byProvider
  mockSqlResults.push([
    { provider: 'openai', total_usd: 1.5, call_count: 10 },
    { provider: 'serpapi', total_usd: 0.5, call_count: 5 },
  ]);
  // 2. detailBusiness (aggregate only — no business_name / subscription_tier)
  mockSqlResults.push([
    {
      business_id: 'biz-1',
      total_usd: 2.0,
      call_count: 15,
      today_usd: 0.1,
    },
  ]);
  // 3. byDay
  mockSqlResults.push([
    { day: '2026-04-17', total_usd: 2.0, call_count: 15 },
  ]);
  // 4. today
  mockSqlResults.push([{ total: 0.1 }]);
  // 5. pageBusinesses (names + tiers for paginated IDs)
  mockSqlResults.push([
    { id: 'biz-1', name: 'Test Biz', subscription_tier: 'standard' },
  ]);
}

function queueDetailPlusRollupResults(): void {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  // 1. byProvider detail
  mockSqlResults.push([
    { provider: 'openai', total_usd: 1.5, call_count: 10 },
    { provider: 'serpapi', total_usd: 0.5, call_count: 5 },
  ]);
  // 2. detailBusiness
  mockSqlResults.push([
    { business_id: 'biz-1', total_usd: 2.0, call_count: 15, today_usd: 0.1 },
  ]);
  // 3. byDay detail
  mockSqlResults.push([
    { day: '2026-04-17', total_usd: 2.0, call_count: 15 },
  ]);
  // 4. today
  mockSqlResults.push([{ total: 0.1 }]);
  // 5. rollupProvider
  mockSqlResults.push([
    { provider: 'openai', total_usd: 0.5, call_count: 3 },
    { provider: 'anthropic', total_usd: 0.2, call_count: 2 },
  ]);
  // 6. rollupDay
  mockSqlResults.push([
    { day: '2025-12-01', total_usd: 0.7, call_count: 5 },
  ]);
  // 7. rollupBusiness
  mockSqlResults.push([
    { business_id: 'biz-1', total_usd: 0.7, call_count: 5 },
  ]);
  // 8. pageBusinesses
  mockSqlResults.push([
    { id: 'biz-1', name: 'Test Biz', subscription_tier: 'standard' },
  ]);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('GET /api/admin/costs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockRequireRole.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      businessId: null,
    });
  });

  it('rejects days > 365 with 400', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=400'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('365');
  });

  it('accepts days = 90 without querying rollups', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=90'));
    expect(res.status).toBe(200);
    expect(sqlCallCounter.value).toBe(5);
  });

  it('queries rollups when days > 90', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    expect(res.status).toBe(200);
    expect(sqlCallCounter.value).toBe(8);
  });

  it('merges byProvider: rollup totals add to detail totals for matching provider', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const openai = body.byProvider.find((p: { provider: string }) => p.provider === 'openai');
    // Detail openai: 1.5, rollup openai: 0.5 → total 2.0
    expect(openai.totalUsd).toBe(2.0);
    expect(openai.callCount).toBe(13); // 10 + 3

    const anthropic = body.byProvider.find((p: { provider: string }) => p.provider === 'anthropic');
    // Only in rollup — 0.2
    expect(anthropic.totalUsd).toBe(0.2);
    expect(anthropic.callCount).toBe(2);
  });

  it('merges byDay: rollup days are non-overlapping and appear in result', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const detailDay = body.byDay.find((d: { day: string }) => d.day === '2026-04-17');
    expect(detailDay.totalUsd).toBe(2.0);

    const rollupDay = body.byDay.find((d: { day: string }) => d.day === '2025-12-01');
    expect(rollupDay).toBeDefined();
    expect(rollupDay.totalUsd).toBe(0.7);
  });

  it('merges byBusiness: rollup contributions added to paginated detail rows', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const biz = body.byBusiness.find((b: { businessId: string }) => b.businessId === 'biz-1');
    // Detail: 2.0, rollup: 0.7 → total 2.7
    expect(biz.totalUsd).toBe(2.7);
    expect(biz.callCount).toBe(20); // 15 + 5
    // today_usd stays detail-only
    expect(biz.todayUsd).toBe(0.1);
  });

  it('byDay result is sorted descending by day', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const days = body.byDay.map((d: { day: string }) => d.day);
    const sorted = [...days].sort((a: string, b: string) => b.localeCompare(a));
    expect(days).toEqual(sorted);
  });

  it('byProvider result is sorted descending by totalUsd', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const totals = body.byProvider.map((p: { totalUsd: number }) => p.totalUsd);
    const sorted = [...totals].sort((a: number, b: number) => b - a);
    expect(totals).toEqual(sorted);
  });

  it('todayTotalUsd stays detail-only (never enriched from rollup)', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    expect(body.todayTotalUsd).toBe(0.1);
  });

  it('days clamped to [1, 365] when out of range below', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    // days=0 must clamp to 1 (not silently default to 7 via ||-short-circuit).
    const res = await GET(makeRequest('/api/admin/costs?days=0'));
    const body = await res.json();
    expect(body.days).toBe(1);
  });

  it('days clamped to [1, 365] when negative', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=-5'));
    const body = await res.json();
    expect(body.days).toBe(1);
  });

  it('falls back to default 7 when days param is not a number', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=abc'));
    const body = await res.json();
    expect(body.days).toBe(7);
  });

  it('returns 401 when auth fails', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs'));
    expect(res.status).toBe(401);
  });

  // Regression: Finding 2 — archived-only businesses disappearing from reporting
  it('includes businesses that have only archived (rollup) activity in byBusiness + totalBusinesses', async () => {
    // Queue: detail business is biz-1 only; rollup business is biz-2 only.
    // Expected: both businesses appear in byBusiness, sorted by combined total.
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    // 1. byProvider
    mockSqlResults.push([{ provider: 'openai', total_usd: 1.0, call_count: 5 }]);
    // 2. detailBusiness — only biz-1 has detail rows
    mockSqlResults.push([
      { business_id: 'biz-1', total_usd: 1.0, call_count: 5, today_usd: 0.1 },
    ]);
    // 3. byDay
    mockSqlResults.push([{ day: '2026-04-17', total_usd: 1.0, call_count: 5 }]);
    // 4. today
    mockSqlResults.push([{ total: 0.1 }]);
    // 5. rollupProvider
    mockSqlResults.push([{ provider: 'anthropic', total_usd: 0.5, call_count: 3 }]);
    // 6. rollupDay
    mockSqlResults.push([{ day: '2025-12-01', total_usd: 0.5, call_count: 3 }]);
    // 7. rollupBusiness — only biz-2 has rollup rows (archived-only)
    mockSqlResults.push([
      { business_id: 'biz-2', total_usd: 0.5, call_count: 3 },
    ]);
    // 8. pageBusinesses for BOTH ids
    mockSqlResults.push([
      { id: 'biz-1', name: 'Biz One', subscription_tier: 'standard' },
      { id: 'biz-2', name: 'Biz Two (archived-only)', subscription_tier: 'standard' },
    ]);

    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    expect(body.totalBusinesses).toBe(2);
    const ids = body.byBusiness.map((b: { businessId: string }) => b.businessId);
    expect(ids).toContain('biz-1');
    expect(ids).toContain('biz-2');

    const bizTwo = body.byBusiness.find((b: { businessId: string }) => b.businessId === 'biz-2');
    expect(bizTwo.totalUsd).toBe(0.5);
    expect(bizTwo.callCount).toBe(3);
    // Archived-only business: no today activity
    expect(bizTwo.todayUsd).toBe(0);
  });

  // Regression: Finding 2 — sorting by combined total, not detail-only total
  it('byBusiness is sorted by combined total (detail + rollup), not detail-only', async () => {
    // biz-1: detail=0.5, rollup=0     → combined=0.5
    // biz-2: detail=0.1, rollup=10.0  → combined=10.1 (should appear first)
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([{ provider: 'openai', total_usd: 1.0, call_count: 5 }]);
    mockSqlResults.push([
      { business_id: 'biz-1', total_usd: 0.5, call_count: 5, today_usd: 0.0 },
      { business_id: 'biz-2', total_usd: 0.1, call_count: 1, today_usd: 0.0 },
    ]);
    mockSqlResults.push([{ day: '2026-04-17', total_usd: 0.6, call_count: 6 }]);
    mockSqlResults.push([{ total: 0.0 }]);
    mockSqlResults.push([]); // rollupProvider empty
    mockSqlResults.push([]); // rollupDay empty
    mockSqlResults.push([{ business_id: 'biz-2', total_usd: 10.0, call_count: 50 }]);
    mockSqlResults.push([
      { id: 'biz-1', name: 'Biz One', subscription_tier: 'standard' },
      { id: 'biz-2', name: 'Biz Two', subscription_tier: 'standard' },
    ]);

    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    // biz-2 should be FIRST because combined total is higher
    expect(body.byBusiness[0].businessId).toBe('biz-2');
    expect(body.byBusiness[1].businessId).toBe('biz-1');
  });

  // Regression: Finding 3 — byDay must additively sum same date in detail + rollup
  it('byDay adds detail + rollup totals for the SAME date (no drop)', async () => {
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockSqlResults.push([{ provider: 'openai', total_usd: 1.5, call_count: 10 }]);
    mockSqlResults.push([
      { business_id: 'biz-1', total_usd: 1.5, call_count: 10, today_usd: 0.0 },
    ]);
    // detail byDay for 2025-12-01: $1.0 (partial — some of this date's rows left in detail)
    mockSqlResults.push([{ day: '2025-12-01', total_usd: 1.0, call_count: 5 }]);
    mockSqlResults.push([{ total: 0.0 }]);
    mockSqlResults.push([]);
    // rollup byDay for SAME date 2025-12-01: $0.5 (other rows already archived)
    mockSqlResults.push([{ day: '2025-12-01', total_usd: 0.5, call_count: 3 }]);
    mockSqlResults.push([]);
    mockSqlResults.push([
      { id: 'biz-1', name: 'Biz One', subscription_tier: 'standard' },
    ]);

    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const day = body.byDay.find((d: { day: string }) => d.day === '2025-12-01');
    expect(day).toBeDefined();
    // Additive: 1.0 (detail) + 0.5 (rollup) = 1.5
    expect(day.totalUsd).toBe(1.5);
    expect(day.callCount).toBe(8); // 5 + 3
  });

  // Regression: Finding 5 — negative limit must clamp to 1, not produce LIMIT -5
  it('limit=-5 clamps to 1, does not produce a LIMIT -5 query', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?limit=-5'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(1);
  });

  it('limit=abc falls back to default 20', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?limit=abc'));
    const body = await res.json();
    expect(body.limit).toBe(20);
  });

  it('offset=-10 clamps to 0', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?offset=-10'));
    const body = await res.json();
    expect(body.offset).toBe(0);
  });
});
