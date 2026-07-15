import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resetServerConfigForTests } from '@/lib/config/server';

// ── Hoisted mocks ───────────────────────────────────────────────────
//
// getCostReport now composes nested `sql` fragments (dateFilter,
// optionalAccountPrefix, rollupBoundary, ...) — a naive Proxy that treats
// every tagged-template call as an independent, awaited top-level query
// (the old approach here) would double-count: each nested fragment call
// would also consume a mockSqlResults slot and appear in capturedSqlTexts.
// The shared `createMockSql` harness (same one worker suites and
// cost-report-service.test.ts use) mirrors real Postgres.js: a nested
// fragment is a lazy thenable that only records + consumes the queue when
// AWAITED, and inlines into the parent query's text otherwise.

const { mockRequireRole, mockGetMarginReport, mockSql, sqlReturnQueue, sqlCalls, resetMockSql } =
  await vi.hoisted(async () => {
    const { createMockSql } = await import('../../../../../../worker/__tests__/helpers/mock-sql');
    return {
      mockRequireRole: vi.fn(),
      mockGetMarginReport: vi.fn(),
      ...createMockSql(),
    };
  });

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

vi.mock('@/lib/admin/margin-service', () => ({
  getMarginReport: (...args: unknown[]) => mockGetMarginReport(...args),
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

// ── Helpers ─────────────────────────────────────────────────────────

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`);
}

function capturedSqlTexts(): string[] {
  return sqlCalls.map((c) => c.text);
}

// Query sequence (matches src/app/api/admin/costs/route.ts):
//
//  Detail-only (days <= 90): 5 queries total
//    1. byProvider      (detail aggregate)
//    2. byBusinessRows  (detail JOIN businesses — paginated + name/tier included)
//    3. businessCount   (detail DISTINCT business_id count)
//    4. byDay           (detail aggregate by date)
//    5. today           (detail sum of today's cost)
//
//  Detail + rollup (days > 90): 7 queries total
//    1. byProvider detail
//    2. byBusinessRows  (server-side UNION CTE: detail + rollup, paginated, name/tier included)
//    3. businessCount   (server-side UNION CTE: distinct business_ids across both)
//    4. byDay detail
//    5. today
//    6. rollupProvider
//    7. rollupDay
//
//  byBusiness rollup is no longer a separate query — it's merged server-side inside #2.

function queueDetailOnlyResults(): void {
  // 1. byProvider
  sqlReturnQueue.push([
    { provider: 'openai', total_usd: 1.5, call_count: 10 },
    { provider: 'serpapi', total_usd: 0.5, call_count: 5 },
  ]);
  // 2. byBusinessRows — already JOIN'd with businesses, has name + subscription_tier
  sqlReturnQueue.push([
    {
      business_id: 'biz-1',
      name: 'Test Biz',
      subscription_tier: 'copilot',
      total_usd: 2.0,
      call_count: 15,
      today_usd: 0.1,
    },
  ]);
  // 3. businessCount
  sqlReturnQueue.push([{ total: 1 }]);
  // 4. byDay
  sqlReturnQueue.push([
    { day: '2026-04-17', total_usd: 2.0, call_count: 15 },
  ]);
  // 5. today
  sqlReturnQueue.push([{ total: 0.1 }]);
}

function queueDetailPlusRollupResults(): void {
  // 1. byProvider detail
  sqlReturnQueue.push([
    { provider: 'openai', total_usd: 1.5, call_count: 10 },
    { provider: 'serpapi', total_usd: 0.5, call_count: 5 },
  ]);
  // 2. byBusinessRows — UNION CTE already combined detail + rollup server-side.
  //    Values reflect combined totals: biz-1 detail(2.0) + rollup(0.7) = 2.7
  sqlReturnQueue.push([
    {
      business_id: 'biz-1',
      name: 'Test Biz',
      subscription_tier: 'copilot',
      total_usd: 2.7,
      call_count: 20,
      today_usd: 0.1,
    },
  ]);
  // 3. businessCount (combined detail ∪ rollup distinct business IDs)
  sqlReturnQueue.push([{ total: 1 }]);
  // 4. byDay detail
  sqlReturnQueue.push([
    { day: '2026-04-17', total_usd: 2.0, call_count: 15 },
  ]);
  // 5. today
  sqlReturnQueue.push([{ total: 0.1 }]);
  // 6. rollupProvider
  sqlReturnQueue.push([
    { provider: 'openai', total_usd: 0.5, call_count: 3 },
    { provider: 'anthropic', total_usd: 0.2, call_count: 2 },
  ]);
  // 7. rollupDay
  sqlReturnQueue.push([
    { day: '2025-12-01', total_usd: 0.7, call_count: 5 },
  ]);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('GET /api/admin/costs', () => {
  const originalTierCostLimits = {
    copilot: process.env.DAILY_COST_LIMIT_CENTS_COPILOT,
    autopilot: process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT,
  };
  const STUB_MARGIN = {
    windowDays: 30,
    platform: {
      totalRevenueUsd: 1000,
      variableApiCogsUsd: 50,
      grossMarginPct: 95,
      riskLevel: 'none' as const,
      note: 'stub',
    },
    topAccountsByCost: [],
    thresholds: {
      accountWarningPct: 25,
      accountActionPct: 40,
      platformWarningPct: 70,
      platformActionPct: 60,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockRequireRole.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      accountId: null,
      locationId: null,
    });
    mockGetMarginReport.mockResolvedValue(STUB_MARGIN);
    // Arbitrary positive fixtures: operator values are required configuration,
    // not product defaults, so route tests must provide them explicitly.
    process.env.DAILY_COST_LIMIT_CENTS_COPILOT = '12345';
    process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '23456';
    resetServerConfigForTests();
  });

  afterEach(() => {
    if (originalTierCostLimits.copilot === undefined) {
      delete process.env.DAILY_COST_LIMIT_CENTS_COPILOT;
    } else {
      process.env.DAILY_COST_LIMIT_CENTS_COPILOT = originalTierCostLimits.copilot;
    }
    if (originalTierCostLimits.autopilot === undefined) {
      delete process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT;
    } else {
      process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = originalTierCostLimits.autopilot;
    }
    resetServerConfigForTests();
  });

  it('fails closed when a required tier cost ceiling is missing', async () => {
    delete process.env.DAILY_COST_LIMIT_CENTS_COPILOT;
    resetServerConfigForTests();

    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=7'));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to fetch cost data' });
    expect(sqlCalls).toHaveLength(0);
    expect(sqlReturnQueue).toHaveLength(0);
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
    expect(sqlCalls).toHaveLength(5);
  });

  it('queries rollups when days > 90', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    expect(res.status).toBe(200);
    // 5 initial (byProvider, byBusiness, businessCount, byDay, today)
    //   + 2 rollup (rollupProvider, rollupDay)
    //   = 7 total. byBusiness rollup is server-side in query #2.
    expect(sqlCalls).toHaveLength(7);
  });

  // ── Regression: boundary-day data loss ─────────────────────────────
  // ArchivalPoller archives rows with `created_at < NOW() - INTERVAL '90 days'`.
  // Rows from the boundary day (CURRENT_DATE - 90 days) are SPLIT: morning
  // hours go to the rollup, afternoon hours stay in api_costs. The rollup
  // filter MUST use `<= CURRENT_DATE - 90 days` (inclusive) or the archived
  // morning portion of the boundary day becomes invisible in reports.
  it('rollup queries use <= (not <) boundary against CURRENT_DATE - 90 days', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    await GET(makeRequest('/api/admin/costs?days=180'));

    // Every SQL fragment that filters on rollup_date against the 90-day
    // boundary MUST use `<=`. Collecting both the byBusiness UNION CTE
    // and the rollupProvider/rollupDay queries.
    const rollupBoundaryQueries = capturedSqlTexts().filter((sql) =>
      sql.includes(`rollup_date`) && sql.includes(`INTERVAL '90 days'`),
    );
    expect(rollupBoundaryQueries.length).toBeGreaterThanOrEqual(3);

    for (const sql of rollupBoundaryQueries) {
      expect(sql).toMatch(/rollup_date\s*<=\s*CURRENT_DATE\s*-\s*INTERVAL '90 days'/);
      expect(sql).not.toMatch(
        /rollup_date\s*<(?!=)\s*CURRENT_DATE\s*-\s*INTERVAL '90 days'/,
      );
    }
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

  // Regression: Finding 2 — archived-only businesses disappearing from reporting.
  // The byBusiness query is now a server-side UNION CTE, so at the mock layer we
  // simulate the SQL having already done the union: biz-2 shows up with rollup-only
  // totals and today_usd=0 because it has no detail activity.
  it('includes businesses that have only archived (rollup) activity in byBusiness + totalBusinesses', async () => {
    // 1. byProvider
    sqlReturnQueue.push([{ provider: 'openai', total_usd: 1.0, call_count: 5 }]);
    // 2. byBusinessRows — server-side UNION CTE already combined detail+rollup.
    //    biz-1 has detail activity, biz-2 has only archived activity (today_usd=0).
    sqlReturnQueue.push([
      {
        business_id: 'biz-1',
        name: 'Biz One',
        subscription_tier: 'copilot',
        total_usd: 1.0,
        call_count: 5,
        today_usd: 0.1,
      },
      {
        business_id: 'biz-2',
        name: 'Biz Two (archived-only)',
        subscription_tier: 'copilot',
        total_usd: 0.5,
        call_count: 3,
        today_usd: 0,
      },
    ]);
    // 3. businessCount (distinct over combined CTE)
    sqlReturnQueue.push([{ total: 2 }]);
    // 4. byDay
    sqlReturnQueue.push([{ day: '2026-04-17', total_usd: 1.0, call_count: 5 }]);
    // 5. today
    sqlReturnQueue.push([{ total: 0.1 }]);
    // 6. rollupProvider
    sqlReturnQueue.push([{ provider: 'anthropic', total_usd: 0.5, call_count: 3 }]);
    // 7. rollupDay
    sqlReturnQueue.push([{ day: '2025-12-01', total_usd: 0.5, call_count: 3 }]);

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

  // Regression: Finding 2 — sorting by combined total.
  // Server-side SQL does the ORDER BY total_usd DESC, so at the mock layer we
  // return rows already in the correct order and verify the route preserves it.
  it('byBusiness is sorted by combined total (detail + rollup), not detail-only', async () => {
    sqlReturnQueue.push([{ provider: 'openai', total_usd: 1.0, call_count: 5 }]);
    // Server-side SQL returns biz-2 first because its combined total (10.1) beats biz-1 (0.5).
    // The mock returns them in that order to validate the route preserves SQL ordering.
    sqlReturnQueue.push([
      {
        business_id: 'biz-2',
        name: 'Biz Two',
        subscription_tier: 'copilot',
        total_usd: 10.1,
        call_count: 51,
        today_usd: 0.0,
      },
      {
        business_id: 'biz-1',
        name: 'Biz One',
        subscription_tier: 'copilot',
        total_usd: 0.5,
        call_count: 5,
        today_usd: 0.0,
      },
    ]);
    sqlReturnQueue.push([{ total: 2 }]);
    sqlReturnQueue.push([{ day: '2026-04-17', total_usd: 0.6, call_count: 6 }]);
    sqlReturnQueue.push([{ total: 0.0 }]);
    sqlReturnQueue.push([]); // rollupProvider empty
    sqlReturnQueue.push([]); // rollupDay empty

    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    // biz-2 should be FIRST because combined total is higher
    expect(body.byBusiness[0].businessId).toBe('biz-2');
    expect(body.byBusiness[1].businessId).toBe('biz-1');
  });

  // Regression: Finding 3 — byDay must additively sum same date in detail + rollup
  it('byDay adds detail + rollup totals for the SAME date (no drop)', async () => {
    // 1. byProvider
    sqlReturnQueue.push([{ provider: 'openai', total_usd: 1.5, call_count: 10 }]);
    // 2. byBusinessRows (combined)
    sqlReturnQueue.push([
      {
        business_id: 'biz-1',
        name: 'Biz One',
        subscription_tier: 'copilot',
        total_usd: 1.5,
        call_count: 10,
        today_usd: 0.0,
      },
    ]);
    // 3. businessCount
    sqlReturnQueue.push([{ total: 1 }]);
    // 4. detail byDay for 2025-12-01: $1.0 (partial — some of this date's rows left in detail)
    sqlReturnQueue.push([{ day: '2025-12-01', total_usd: 1.0, call_count: 5 }]);
    // 5. today
    sqlReturnQueue.push([{ total: 0.0 }]);
    // 6. rollupProvider (empty)
    sqlReturnQueue.push([]);
    // 7. rollup byDay for SAME date 2025-12-01: $0.5 (other rows already archived)
    sqlReturnQueue.push([{ day: '2025-12-01', total_usd: 0.5, call_count: 3 }]);

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

  // Regression: Finding (follow-up) — server-side pagination means limit/offset
  // are interpolated into the byBusinessRows query, not app-side slice.
  it('byBusiness SQL query receives limit and offset as interpolated values', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?limit=50&offset=10'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(10);
    // byBusinessRows is sqlCalls[1] — assert LIMIT/OFFSET are bound values,
    // not string-interpolated into the query text.
    const byBusinessCall = sqlCalls[1]!;
    expect(byBusinessCall.text).toContain('LIMIT ? OFFSET ?');
    expect(byBusinessCall.values).toContain(50);
    expect(byBusinessCall.values).toContain(10);
  });

  // ── Margin integration ───────────────────────────────────────────────

  it('happy path: 200 response includes both cost-report fields and a margin key', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=7'));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Cost-report fields must still be present
    expect(body).toHaveProperty('byProvider');
    expect(body).toHaveProperty('byDay');
    expect(body).toHaveProperty('byBusiness');
    // Margin key must equal the mocked getMarginReport return
    expect(body.margin).toEqual(STUB_MARGIN);
    expect(mockGetMarginReport).toHaveBeenCalledOnce();
    expect(mockGetMarginReport).toHaveBeenCalledWith(mockSql, { limit: 20 });
  });

  it('non-admin auth rejection: neither getCostReport nor getMarginReport is called', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Forbidden', 403));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs'));
    expect(res.status).toBe(403);
    expect(mockGetMarginReport).not.toHaveBeenCalled();
    // sqlCalls stays empty: getCostReport was never invoked
    expect(sqlCalls).toHaveLength(0);
  });

  it('getMarginReport failure is best-effort: 200 with margin null, cost report intact', async () => {
    queueDetailOnlyResults();
    mockGetMarginReport.mockRejectedValue(new Error('DB timeout'));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=7'));
    // A fault in the new margin query must NOT take down the pre-existing cost report.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.margin).toBeNull();
    // Cost-report fields are still present (getCostReport ran against the sql mock).
    expect(body.byProvider).toBeDefined();
  });

  // ── Regression: api_costs_daily_rollups ──────────────────────────────

  // Regression: api_costs_daily_rollups has NO account_id column — rollup
  // queries must JOIN through businesses instead of filtering directly.
  // This prevents a runtime SQL error when account_id parameter is provided
  // with days > 90.
  it('rollup queries use JOIN-through-businesses pattern, not direct account_id on rollups table', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    await GET(makeRequest('/api/admin/costs?days=180&account_id=acct-123'));

    // Every SQL that references api_costs_daily_rollups must NOT contain
    // a direct `AND account_id =` predicate on that table. Instead it
    // must use a subquery: business_id IN (SELECT id FROM businesses WHERE account_id = ...)
    const rollupQueries = capturedSqlTexts().filter(
      (sql) => sql.includes('api_costs_daily_rollups'),
    );
    expect(rollupQueries.length).toBeGreaterThanOrEqual(1);

    for (const sql of rollupQueries) {
      const rollupClauses = sql
        .split(/FROM\s+api_costs_daily_rollups/i)
        .slice(1)
        .map((part) => part.split(/GROUP BY/i)[0]);
      expect(rollupClauses.length).toBeGreaterThanOrEqual(1);

      // Must NOT have a direct account_id predicate against the rollups table.
      // The only allowed account_id predicate is inside the businesses subquery.
      for (const clause of rollupClauses) {
        expect(clause).not.toMatch(/^\s*(AND|WHERE)\s+account_id\s*=\s*\?::uuid/im);
        expect(clause).toMatch(
          /business_id\s+IN\s*\(\s*SELECT\s+id\s+FROM\s+businesses\s+WHERE\s+account_id\s*=\s*\?::uuid\s*\)/i,
        );
      }
    }
  });
});
