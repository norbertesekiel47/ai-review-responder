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
    apply: () => {
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

function queueDetailOnlyResults(): void {
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  // 1. byProvider
  mockSqlResults.push([
    { provider: 'openai', total_usd: 1.5, call_count: 10 },
    { provider: 'serpapi', total_usd: 0.5, call_count: 5 },
  ]);
  // 2. byBusiness
  mockSqlResults.push([
    {
      business_id: 'biz-1',
      business_name: 'Test Biz',
      subscription_tier: 'standard',
      total_usd: 2.0,
      call_count: 15,
      today_usd: 0.1,
    },
  ]);
  // 3. businessCount
  mockSqlResults.push([{ total: 1 }]);
  // 4. byDay
  mockSqlResults.push([
    { day: '2026-04-17', total_usd: 2.0, call_count: 15 },
  ]);
  // 5. today
  mockSqlResults.push([{ total: 0.1 }]);
}

function queueDetailPlusRollupResults(): void {
  queueDetailOnlyResults();
  // 3 rollup queries: rollupProvider, rollupDay, rollupBusiness
  mockSqlResults.push([
    { provider: 'openai', total_usd: 0.5, call_count: 3 },
    { provider: 'anthropic', total_usd: 0.2, call_count: 2 },
  ]);
  mockSqlResults.push([
    { day: '2025-12-01', total_usd: 0.7, call_count: 5 },
  ]);
  mockSqlResults.push([
    { business_id: 'biz-1', total_usd: 0.7, call_count: 5 },
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
    // Use -5 (truthy, bypasses the `|| 7` fallback) so we exercise the Math.max(·, 1) clamp.
    const res = await GET(makeRequest('/api/admin/costs?days=-5'));
    const body = await res.json();
    expect(body.days).toBe(1);
  });

  it('returns 401 when auth fails', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs'));
    expect(res.status).toBe(401);
  });
});
