import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCostQuery } from '../cost-report-service';

// ── getCostReport quadrant coverage ──────────────────────────────────
// The route-level test covers:
//   - accountId unset + needsRollup false  (days=90, 5 queries)
//   - accountId unset + needsRollup true   (days=180, 7 queries)
//   - accountId set   + needsRollup true   (days=180&account_id=..., JOIN-through-businesses)
//
// Missing quadrant: accountId SET + needsRollup FALSE (days<=90, account_id provided).
// This quadrant takes the 4th branch in each multi-branch SQL ternary (no rollup, has accountId).
// Covered here at the service level.

const { mockSqlResults, sqlCallCounter } = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
}));

const capturedSqlTexts: string[] = [];

vi.mock('@/lib/db/server', () => {
  const sqlProxy = new Proxy(() => {}, {
    apply: (_target, _thisArg, argumentsList) => {
      const first = argumentsList[0];
      const isTaggedTemplate =
        first != null && typeof first === 'object' && 'raw' in (first as object);
      if (!isTaggedTemplate) {
        return { __helper: true };
      }
      capturedSqlTexts.push((first as TemplateStringsArray).raw.join('?'));
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }) as unknown;
  return { sql: sqlProxy, jsonb: (v: unknown) => v };
});

describe('parseCostQuery', () => {
  it('returns defaults when no params provided', () => {
    const result = parseCostQuery(new URLSearchParams(''));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(7);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.accountId).toBe('');
  });

  it('clamps days=0 to 1 (not silently default to 7)', () => {
    const result = parseCostQuery(new URLSearchParams('days=0'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(1);
  });

  it('clamps negative days=-5 to 1', () => {
    const result = parseCostQuery(new URLSearchParams('days=-5'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(1);
  });

  it('clamps limit=-5 to 1', () => {
    const result = parseCostQuery(new URLSearchParams('limit=-5'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.limit).toBe(1);
  });

  it('clamps offset=-3 to 0', () => {
    const result = parseCostQuery(new URLSearchParams('offset=-3'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.offset).toBe(0);
  });

  it('returns error for days=400', () => {
    const result = parseCostQuery(new URLSearchParams('days=400'));
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toBe('days parameter must be 365 or less');
  });

  it('falls back to 7 when days is non-numeric', () => {
    const result = parseCostQuery(new URLSearchParams('days=abc'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(7);
  });

  it('falls back to 20 when limit is non-numeric', () => {
    const result = parseCostQuery(new URLSearchParams('limit=abc'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.limit).toBe(20);
  });

  it('falls back to 0 when offset is non-numeric', () => {
    const result = parseCostQuery(new URLSearchParams('offset=abc'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.offset).toBe(0);
  });

  it('caps limit at 100', () => {
    const result = parseCostQuery(new URLSearchParams('limit=200'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.limit).toBe(100);
  });

  it('caps days at 365', () => {
    const result = parseCostQuery(new URLSearchParams('days=365'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.days).toBe(365);
  });

  it('parses accountId when provided', () => {
    const result = parseCostQuery(new URLSearchParams('account_id=acct-123'));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    // asAccountId is a nominal cast — value is preserved
    expect(result.accountId).toBe('acct-123');
  });

  it('leaves accountId as empty string when not provided', () => {
    const result = parseCostQuery(new URLSearchParams(''));
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.accountId).toBe('');
  });
});

// ── getCostReport: accountId SET + needsRollup FALSE ──────────────────
// Quadrant: days <= 90 with account_id filter. This takes the `accountId`-set
// detail-only branches (no CTE UNION, no rollup queries) — exactly 5 SQL calls.
describe('getCostReport — accountId set, no rollup (days ≤ 90)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    capturedSqlTexts.length = 0;
  });

  it('issues exactly 5 queries (no rollup queries) when days<=90 and accountId is set', async () => {
    // Queue 5 results: byProvider, byBusiness, businessCount, byDay, today
    mockSqlResults.push([{ provider: 'openai', total_usd: 0.8, call_count: 4 }]);
    mockSqlResults.push([
      {
        business_id: 'biz-acct-1',
        name: 'Account Biz',
        subscription_tier: 'premium',
        total_usd: 0.8,
        call_count: 4,
        today_usd: 0.2,
      },
    ]);
    mockSqlResults.push([{ total: 1 }]);
    mockSqlResults.push([{ day: '2026-05-19', total_usd: 0.8, call_count: 4 }]);
    mockSqlResults.push([{ total: 0.2 }]);

    const { getCostReport } = await import('../cost-report-service');
    const result = await getCostReport({
      days: 30,
      limit: 20,
      offset: 0,
      accountId: 'acct-abc-123' as ReturnType<typeof import('@/lib/shared/ids').asAccountId>,
    });

    expect(sqlCallCounter.value).toBe(5);
    expect(result.days).toBe(30);
    expect(result.totalBusinesses).toBe(1);
    expect(result.byProvider).toHaveLength(1);
    const provider = result.byProvider[0]!;
    expect(provider.provider).toBe('openai');
    expect(provider.totalUsd).toBe(0.8);
    expect(result.byBusiness).toHaveLength(1);
    const biz = result.byBusiness[0]!;
    expect(biz.businessId).toBe('biz-acct-1');
    expect(biz.subscriptionTier).toBe('premium');
    // todayUsd / dailyLimitUsd for premium tier: 2000 cents = $20
    expect(biz.dailyLimitUsd).toBe(20);
    expect(biz.pctOfDailyLimit).toBe(1); // 0.2/20 * 100 = 1%
    expect(result.byDay).toHaveLength(1);
    const day = result.byDay[0]!;
    expect(day.day).toBe('2026-05-19');
    expect(result.todayTotalUsd).toBe(0.2);
  });

  it('accountId-scoped queries use account_id filter (not global scan)', async () => {
    mockSqlResults.push([]);
    mockSqlResults.push([]);
    mockSqlResults.push([{ total: 0 }]);
    mockSqlResults.push([]);
    mockSqlResults.push([{ total: 0 }]);

    const { getCostReport } = await import('../cost-report-service');
    await getCostReport({
      days: 7,
      limit: 20,
      offset: 0,
      accountId: 'acct-xyz' as ReturnType<typeof import('@/lib/shared/ids').asAccountId>,
    });

    // All 5 queries that touch api_costs directly should include account_id filter.
    const apiCostQueries = capturedSqlTexts.filter((s) => s.includes('api_costs') && !s.includes('api_costs_daily_rollups'));
    expect(apiCostQueries.length).toBeGreaterThanOrEqual(3);
    for (const q of apiCostQueries) {
      expect(q).toMatch(/account_id\s*=\s*\?::uuid/);
    }
  });

  it('does not generate any rollup SQL when days=90', async () => {
    mockSqlResults.push([{ provider: 'serpapi', total_usd: 0.3, call_count: 2 }]);
    mockSqlResults.push([]);
    mockSqlResults.push([{ total: 0 }]);
    mockSqlResults.push([]);
    mockSqlResults.push([{ total: 0 }]);

    const { getCostReport } = await import('../cost-report-service');
    await getCostReport({
      days: 90,
      limit: 20,
      offset: 0,
      accountId: 'acct-xyz' as ReturnType<typeof import('@/lib/shared/ids').asAccountId>,
    });

    const rollupQueries = capturedSqlTexts.filter((s) => s.includes('api_costs_daily_rollups'));
    expect(rollupQueries).toHaveLength(0);
    expect(sqlCallCounter.value).toBe(5);
  });
});
