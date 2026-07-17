import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asAccountId } from '@/lib/shared/ids';
import type { RecordedSqlCall } from '../../../../worker/__tests__/helpers/mock-sql';
import { parseCostQuery } from '../cost-report-service';

// ── getCostReport SQL characterization (A+ campaign PR 2b, T2) ────────
//
// getCostReport currently branches on accountId (present/absent) x
// needsRollup (days>90) with ~8 near-copy-pasted `sql` template variants
// (see src/lib/admin/cost-report-service.ts). Before injecting `sql` as a
// parameter and collapsing those branches into fragment composition, the
// tests below PIN the exact SQL text + bound values produced by the
// CURRENT (unrefactored) code for all 4 {accountId x needsRollup}
// combinations. Postgres.js inlines nested `sql` fragments into the parent
// query's text before it reaches the wire, and the shared `createMockSql`
// harness flattens them the same way — so if the post-refactor fragment
// composition produces byte-identical text, these exact same assertions
// keep passing unchanged. That is the behavior-preservation proof for T2.
//
// Pinned text below was captured by running the CURRENT code (this file,
// pre-refactor) against `createMockSql`, not hand-transcribed — see the
// task's capture script. `?` stands in for a bound value (mock convention).

const NOACCT_NOROLLUP: RecordedSqlCall[] = [
  {
    text: `
          SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count
          FROM api_costs
          WHERE created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY provider
          ORDER BY total_usd DESC
        `,
    values: [30],
  },
  {
    text: `
          SELECT ac.business_id, b.name, a.subscription_tier,
                 SUM(ac.cost_usd)::float AS total_usd,
                 COUNT(ac.id)::float AS call_count,
                 SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd
          FROM api_costs ac
          JOIN businesses b ON b.id = ac.business_id
          JOIN accounts a ON a.id = b.account_id
          WHERE ac.created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY ac.business_id, b.name, a.subscription_tier
          ORDER BY total_usd DESC, ac.business_id ASC
          LIMIT ? OFFSET ?
        `,
    values: [30, 20, 0],
  },
  {
    text: `
          SELECT COUNT(DISTINCT business_id)::int AS total
          FROM api_costs
          WHERE created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
            AND business_id IS NOT NULL
        `,
    values: [30],
  },
  {
    text: `
          SELECT
            DATE(created_at)::text AS day,
            SUM(cost_usd)::float AS total_usd,
            COUNT(*)::float AS call_count
          FROM api_costs
          WHERE created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY DATE(created_at)
          ORDER BY day DESC
        `,
    values: [30],
  },
  {
    text: `
          SELECT COALESCE(SUM(cost_usd), 0)::float AS total
          FROM api_costs
          WHERE created_at >= CURRENT_DATE
        `,
    values: [],
  },
];

const ACCT_NOROLLUP: RecordedSqlCall[] = [
  {
    text: `
          SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count
          FROM api_costs
          WHERE account_id = ?::uuid
            AND created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY provider
          ORDER BY total_usd DESC
        `,
    values: ['acct-abc-123', 30],
  },
  {
    text: `
          SELECT ac.business_id, b.name, a.subscription_tier,
                 SUM(ac.cost_usd)::float AS total_usd,
                 COUNT(ac.id)::float AS call_count,
                 SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd
          FROM api_costs ac
          JOIN businesses b ON b.id = ac.business_id
          JOIN accounts a ON a.id = b.account_id
          WHERE ac.account_id = ?::uuid
            AND ac.created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY ac.business_id, b.name, a.subscription_tier
          ORDER BY total_usd DESC, ac.business_id ASC
          LIMIT ? OFFSET ?
        `,
    values: ['acct-abc-123', 30, 20, 0],
  },
  {
    text: `
          SELECT COUNT(DISTINCT business_id)::int AS total
          FROM api_costs
          WHERE account_id = ?::uuid
            AND created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
            AND business_id IS NOT NULL
        `,
    values: ['acct-abc-123', 30],
  },
  {
    text: `
          SELECT
            DATE(created_at)::text AS day,
            SUM(cost_usd)::float AS total_usd,
            COUNT(*)::float AS call_count
          FROM api_costs
          WHERE account_id = ?::uuid
            AND created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY DATE(created_at)
          ORDER BY day DESC
        `,
    values: ['acct-abc-123', 30],
  },
  {
    text: `
          SELECT COALESCE(SUM(cost_usd), 0)::float AS total
          FROM api_costs
          WHERE account_id = ?::uuid
            AND created_at >= CURRENT_DATE
        `,
    values: ['acct-abc-123'],
  },
];

const NOACCT_ROLLUP: RecordedSqlCall[] = [
  {
    text: `
          SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count
          FROM api_costs
          WHERE created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY provider
          ORDER BY total_usd DESC
        `,
    values: [180],
  },
  {
    text: `
          WITH combined AS (
            SELECT business_id,
                   SUM(cost_usd)::float AS total_usd,
                   COUNT(*)::float AS call_count,
                   SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd
            FROM api_costs
            WHERE created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND business_id IS NOT NULL
            GROUP BY business_id
            UNION ALL
            SELECT business_id,
                   SUM(total_cost_usd)::float AS total_usd,
                   SUM(call_count)::float AS call_count,
                   0::float AS today_usd
            FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
              AND business_id IS NOT NULL
            GROUP BY business_id
          ),
          business_totals AS (
            SELECT business_id,
                   SUM(total_usd)::float AS total_usd,
                   SUM(call_count)::float AS call_count,
                   SUM(today_usd)::float AS today_usd
            FROM combined
            GROUP BY business_id
          )
          SELECT bt.business_id, b.name, a.subscription_tier,
                 bt.total_usd, bt.call_count, bt.today_usd
          FROM business_totals bt
          JOIN businesses b ON b.id = bt.business_id
          JOIN accounts a ON a.id = b.account_id
          ORDER BY bt.total_usd DESC, bt.business_id ASC
          LIMIT ? OFFSET ?
        `,
    values: [180, 180, 20, 0],
  },
  {
    text: `
          WITH combined AS (
            SELECT business_id FROM api_costs
            WHERE created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND business_id IS NOT NULL
            GROUP BY business_id
            UNION
            SELECT business_id FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
              AND business_id IS NOT NULL
            GROUP BY business_id
          )
          SELECT COUNT(*)::int AS total FROM combined
        `,
    values: [180, 180],
  },
  {
    text: `
          SELECT
            DATE(created_at)::text AS day,
            SUM(cost_usd)::float AS total_usd,
            COUNT(*)::float AS call_count
          FROM api_costs
          WHERE created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY DATE(created_at)
          ORDER BY day DESC
        `,
    values: [180],
  },
  {
    text: `
          SELECT COALESCE(SUM(cost_usd), 0)::float AS total
          FROM api_costs
          WHERE created_at >= CURRENT_DATE
        `,
    values: [],
  },
  {
    text: `
            SELECT provider, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count
            FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY provider
          `,
    values: [180],
  },
  {
    text: `
            SELECT rollup_date::text AS day, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count
            FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY rollup_date
          `,
    values: [180],
  },
];

const ACCT_ROLLUP: RecordedSqlCall[] = [
  {
    text: `
          SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::float AS call_count
          FROM api_costs
          WHERE account_id = ?::uuid
            AND created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY provider
          ORDER BY total_usd DESC
        `,
    values: ['acct-abc-123', 180],
  },
  {
    text: `
          WITH combined AS (
            SELECT business_id,
                   SUM(cost_usd)::float AS total_usd,
                   COUNT(*)::float AS call_count,
                   SUM(CASE WHEN created_at >= CURRENT_DATE THEN cost_usd ELSE 0 END)::float AS today_usd
            FROM api_costs
            WHERE account_id = ?::uuid
              AND created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND business_id IS NOT NULL
            GROUP BY business_id
            UNION ALL
            SELECT business_id,
                   SUM(total_cost_usd)::float AS total_usd,
                   SUM(call_count)::float AS call_count,
                   0::float AS today_usd
            FROM api_costs_daily_rollups
            WHERE rollup_date >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
              AND business_id IS NOT NULL
              AND business_id IN (SELECT id FROM businesses WHERE account_id = ?::uuid)
            GROUP BY business_id
          ),
          business_totals AS (
            SELECT business_id,
                   SUM(total_usd)::float AS total_usd,
                   SUM(call_count)::float AS call_count,
                   SUM(today_usd)::float AS today_usd
            FROM combined
            GROUP BY business_id
          )
          SELECT bt.business_id, b.name, a.subscription_tier,
                 bt.total_usd, bt.call_count, bt.today_usd
          FROM business_totals bt
          JOIN businesses b ON b.id = bt.business_id
          JOIN accounts a ON a.id = b.account_id
          ORDER BY bt.total_usd DESC, bt.business_id ASC
          LIMIT ? OFFSET ?
        `,
    values: ['acct-abc-123', 180, 180, 'acct-abc-123', 20, 0],
  },
  {
    text: `
          WITH combined AS (
            SELECT business_id FROM api_costs
            WHERE account_id = ?::uuid
              AND created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND business_id IS NOT NULL
            GROUP BY business_id
            UNION
            SELECT business_id FROM api_costs_daily_rollups
            WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ?::uuid)
              AND rollup_date >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
              AND business_id IS NOT NULL
            GROUP BY business_id
          )
          SELECT COUNT(*)::int AS total FROM combined
        `,
    values: ['acct-abc-123', 180, 'acct-abc-123', 180],
  },
  {
    text: `
          SELECT
            DATE(created_at)::text AS day,
            SUM(cost_usd)::float AS total_usd,
            COUNT(*)::float AS call_count
          FROM api_costs
          WHERE account_id = ?::uuid
            AND created_at >= CURRENT_DATE - ?::int * INTERVAL '1 day'
          GROUP BY DATE(created_at)
          ORDER BY day DESC
        `,
    values: ['acct-abc-123', 180],
  },
  {
    text: `
          SELECT COALESCE(SUM(cost_usd), 0)::float AS total
          FROM api_costs
          WHERE account_id = ?::uuid
            AND created_at >= CURRENT_DATE
        `,
    values: ['acct-abc-123'],
  },
  {
    text: `
            SELECT provider, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count
            FROM api_costs_daily_rollups
            WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ?::uuid)
              AND rollup_date >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY provider
          `,
    values: ['acct-abc-123', 180],
  },
  {
    text: `
            SELECT rollup_date::text AS day, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::float AS call_count
            FROM api_costs_daily_rollups
            WHERE business_id IN (SELECT id FROM businesses WHERE account_id = ?::uuid)
              AND rollup_date >= CURRENT_DATE - ?::int * INTERVAL '1 day'
              AND rollup_date <= CURRENT_DATE - INTERVAL '90 days'
            GROUP BY rollup_date
          `,
    values: ['acct-abc-123', 180],
  },
];

function expectPinnedCalls(actual: RecordedSqlCall[], expected: RecordedSqlCall[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((exp, i) => {
    expect(actual[i]!.text).toBe(exp.text);
    expect(actual[i]!.values).toEqual(exp.values);
  });
}

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import type { Sql } from 'postgres';
import { getCostReport } from '../cost-report-service';
import { resetServerConfigForTests } from '@/lib/config/server';

const sql = mockSql as unknown as Sql;

beforeEach(() => {
  resetMockSql();
  process.env.DAILY_COST_LIMIT_CENTS_COPILOT = '1000';
  process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '2000';
  resetServerConfigForTests();
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

// ── getCostReport: accountId SET + needsRollup FALSE (existing coverage) ──
// Quadrant: days <= 90 with account_id filter. Kept from before the T2
// refactor (do not weaken); only the sql-wiring mechanism changed (shared
// createMockSql harness instead of an ad hoc Proxy).
describe('getCostReport — accountId set, no rollup (days ≤ 90)', () => {
  it('fails before querying when an owning server cost ceiling is missing', async () => {
    delete process.env.DAILY_COST_LIMIT_CENTS_COPILOT;
    resetServerConfigForTests();

    await expect(getCostReport(sql, {
      days: 30,
      limit: 20,
      offset: 0,
      accountId: '',
    })).rejects.toThrow(/DAILY_COST_LIMIT_CENTS_COPILOT/);
    expect(sqlCalls).toHaveLength(0);
  });

  it('issues exactly 5 queries (no rollup queries) when days<=90 and accountId is set', async () => {
    sqlReturnQueue.push([{ provider: 'openai', total_usd: 0.8, call_count: 4 }]);
    sqlReturnQueue.push([
      {
        business_id: 'biz-acct-1',
        name: 'Account Biz',
        subscription_tier: 'autopilot',
        total_usd: 0.8,
        call_count: 4,
        today_usd: 0.2,
      },
    ]);
    sqlReturnQueue.push([{ total: 1 }]);
    sqlReturnQueue.push([{ day: '2026-05-19', total_usd: 0.8, call_count: 4 }]);
    sqlReturnQueue.push([{ total: 0.2 }]);

    const result = await getCostReport(sql, {
      days: 30,
      limit: 20,
      offset: 0,
      accountId: asAccountId('acct-abc-123'),
    });

    expect(sqlCalls).toHaveLength(5);
    expect(result.days).toBe(30);
    expect(result.totalBusinesses).toBe(1);
    expect(result.byProvider).toHaveLength(1);
    const provider = result.byProvider[0]!;
    expect(provider.provider).toBe('openai');
    expect(provider.totalUsd).toBe(0.8);
    expect(result.byBusiness).toHaveLength(1);
    const biz = result.byBusiness[0]!;
    expect(biz.businessId).toBe('biz-acct-1');
    expect(biz.subscriptionTier).toBe('autopilot');
    // Autopilot ceiling: 2000 cents = $20.
    expect(biz.dailyLimitUsd).toBe(20);
    expect(biz.pctOfDailyLimit).toBe(1); // 0.2/20 * 100 = 1%
    expect(result.byDay).toHaveLength(1);
    const day = result.byDay[0]!;
    expect(day.day).toBe('2026-05-19');
    expect(result.todayTotalUsd).toBe(0.2);
  });

  it('accountId-scoped queries use account_id filter (not global scan)', async () => {
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ total: 0 }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ total: 0 }]);

    await getCostReport(sql, {
      days: 7,
      limit: 20,
      offset: 0,
      accountId: asAccountId('acct-xyz'),
    });

    // All 5 queries that touch api_costs directly should include account_id filter.
    const apiCostQueries = sqlCalls.filter(
      (c) => c.text.includes('api_costs') && !c.text.includes('api_costs_daily_rollups'),
    );
    expect(apiCostQueries).toHaveLength(5);
    for (const q of apiCostQueries) {
      expect(q.text).toMatch(/account_id\s*=\s*\?::uuid/);
    }
  });

  it('does not generate any rollup SQL when days=90', async () => {
    sqlReturnQueue.push([{ provider: 'serpapi', total_usd: 0.3, call_count: 2 }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ total: 0 }]);
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([{ total: 0 }]);

    await getCostReport(sql, {
      days: 90,
      limit: 20,
      offset: 0,
      accountId: asAccountId('acct-xyz'),
    });

    const rollupQueries = sqlCalls.filter((c) => c.text.includes('api_costs_daily_rollups'));
    expect(rollupQueries).toHaveLength(0);
    expect(sqlCalls).toHaveLength(5);
  });
});

// ── getCostReport: pinned-SQL characterization, all 4 quadrants ───────
// Each test pins the EXACT SQL text + bound values for every query
// getCostReport issues (see PINNED constants above), and separately
// asserts the resulting CostData shape. These are the byte-identity
// safety net for the T2 sql-injection + fragment-composition refactor:
// if the refactored code still produces this exact text, behavior is
// provably unchanged.
describe('getCostReport — pinned SQL + shape (4 quadrants)', () => {
  it('accountId unset, no rollup (days=30): 5 queries, pinned text', async () => {
    sqlReturnQueue.push([{ provider: 'openai', total_usd: 1.2, call_count: 6 }]);
    sqlReturnQueue.push([
      {
        business_id: 'biz-1',
        name: 'Biz One',
        subscription_tier: 'copilot',
        total_usd: 1.2,
        call_count: 6,
        today_usd: 0.3,
      },
    ]);
    sqlReturnQueue.push([{ total: 1 }]);
    sqlReturnQueue.push([{ day: '2026-07-01', total_usd: 1.2, call_count: 6 }]);
    sqlReturnQueue.push([{ total: 0.3 }]);

    const result = await getCostReport(sql, { days: 30, limit: 20, offset: 0, accountId: '' });

    expectPinnedCalls(sqlCalls, NOACCT_NOROLLUP);

    expect(result.days).toBe(30);
    expect(result.totalBusinesses).toBe(1);
    expect(result.byProvider).toEqual([{ provider: 'openai', totalUsd: 1.2, callCount: 6 }]);
    expect(result.byBusiness).toHaveLength(1);
    expect(result.byBusiness[0]).toMatchObject({
      businessId: 'biz-1',
      subscriptionTier: 'copilot',
      totalUsd: 1.2,
      callCount: 6,
      todayUsd: 0.3,
      dailyLimitUsd: 10, // Copilot ceiling: 1000 cents
      pctOfDailyLimit: 3, // 0.3/10*100 = 3
    });
    expect(result.byDay).toEqual([{ day: '2026-07-01', totalUsd: 1.2, callCount: 6 }]);
    expect(result.todayTotalUsd).toBe(0.3);
  });

  it('accountId set, no rollup (days=30): 5 queries, pinned text', async () => {
    sqlReturnQueue.push([{ provider: 'openai', total_usd: 1.2, call_count: 6 }]);
    sqlReturnQueue.push([
      {
        business_id: 'biz-1',
        name: 'Biz One',
        subscription_tier: 'copilot',
        total_usd: 1.2,
        call_count: 6,
        today_usd: 0.3,
      },
    ]);
    sqlReturnQueue.push([{ total: 1 }]);
    sqlReturnQueue.push([{ day: '2026-07-01', total_usd: 1.2, call_count: 6 }]);
    sqlReturnQueue.push([{ total: 0.3 }]);

    const result = await getCostReport(sql, {
      days: 30,
      limit: 20,
      offset: 0,
      accountId: asAccountId('acct-abc-123'),
    });

    expectPinnedCalls(sqlCalls, ACCT_NOROLLUP);

    expect(result.days).toBe(30);
    expect(result.totalBusinesses).toBe(1);
    expect(result.byProvider).toEqual([{ provider: 'openai', totalUsd: 1.2, callCount: 6 }]);
    expect(result.byDay).toEqual([{ day: '2026-07-01', totalUsd: 1.2, callCount: 6 }]);
    expect(result.todayTotalUsd).toBe(0.3);
  });

  it('accountId unset, rollup (days=180): 7 queries, pinned text, provider+day merge', async () => {
    sqlReturnQueue.push([{ provider: 'anthropic', total_usd: 2.0, call_count: 10 }]);
    sqlReturnQueue.push([
      {
        business_id: 'biz-2',
        name: 'Biz Two',
        subscription_tier: 'autopilot',
        total_usd: 3.0,
        call_count: 15,
        today_usd: 0.5,
      },
    ]);
    sqlReturnQueue.push([{ total: 2 }]);
    sqlReturnQueue.push([{ day: '2026-07-01', total_usd: 2.0, call_count: 10 }]);
    sqlReturnQueue.push([{ total: 0.5 }]);
    sqlReturnQueue.push([{ provider: 'anthropic', total_usd: 1.0, call_count: 5 }]);
    sqlReturnQueue.push([{ day: '2026-04-01', total_usd: 1.0, call_count: 5 }]);

    const result = await getCostReport(sql, { days: 180, limit: 20, offset: 0, accountId: '' });

    expectPinnedCalls(sqlCalls, NOACCT_ROLLUP);

    expect(result.days).toBe(180);
    expect(result.totalBusinesses).toBe(2);
    // Detail (2.0/10) + rollup (1.0/5) merged additively for the same provider key.
    expect(result.byProvider).toEqual([{ provider: 'anthropic', totalUsd: 3.0, callCount: 15 }]);
    expect(result.byBusiness).toHaveLength(1);
    expect(result.byBusiness[0]).toMatchObject({
      businessId: 'biz-2',
      subscriptionTier: 'autopilot',
      totalUsd: 3.0,
      callCount: 15,
      todayUsd: 0.5,
      dailyLimitUsd: 20,
      pctOfDailyLimit: 3, // 0.5/20*100 = 2.5 -> round 3
    });
    // Detail day and rollup day are disjoint dates -> both kept, sorted descending.
    expect(result.byDay).toEqual([
      { day: '2026-07-01', totalUsd: 2.0, callCount: 10 },
      { day: '2026-04-01', totalUsd: 1.0, callCount: 5 },
    ]);
    expect(result.todayTotalUsd).toBe(0.5);
  });

  it('accountId set, rollup (days=180): 7 queries, pinned text, provider+day merge', async () => {
    sqlReturnQueue.push([{ provider: 'anthropic', total_usd: 2.0, call_count: 10 }]);
    sqlReturnQueue.push([
      {
        business_id: 'biz-2',
        name: 'Biz Two',
        subscription_tier: 'autopilot',
        total_usd: 3.0,
        call_count: 15,
        today_usd: 0.5,
      },
    ]);
    sqlReturnQueue.push([{ total: 2 }]);
    sqlReturnQueue.push([{ day: '2026-07-01', total_usd: 2.0, call_count: 10 }]);
    sqlReturnQueue.push([{ total: 0.5 }]);
    sqlReturnQueue.push([{ provider: 'anthropic', total_usd: 1.0, call_count: 5 }]);
    sqlReturnQueue.push([{ day: '2026-04-01', total_usd: 1.0, call_count: 5 }]);

    const result = await getCostReport(sql, {
      days: 180,
      limit: 20,
      offset: 0,
      accountId: asAccountId('acct-abc-123'),
    });

    expectPinnedCalls(sqlCalls, ACCT_ROLLUP);

    expect(result.days).toBe(180);
    expect(result.totalBusinesses).toBe(2);
    expect(result.byProvider).toEqual([{ provider: 'anthropic', totalUsd: 3.0, callCount: 15 }]);
    expect(result.byDay).toEqual([
      { day: '2026-07-01', totalUsd: 2.0, callCount: 10 },
      { day: '2026-04-01', totalUsd: 1.0, callCount: 5 },
    ]);
    expect(result.todayTotalUsd).toBe(0.5);
  });
});
