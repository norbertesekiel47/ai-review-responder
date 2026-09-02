// src/lib/dashboard/__tests__/service.statement-count.test.ts
//
// Pins the number of SQL statements one dashboard cache MISS issues. The wave
// is strictly sequential on the pool-3 `sql` client (#505/#773), so every
// statement is one full round-trip of latency on the miss path: a widget that
// grows the budget by "just one more query" must change this number on
// purpose, in review, not by accident.
//
// Two folds keep the budget where it is (see the wave comment in service.ts):
// the all-time review total rides the rating-breakdown GROUP BY, and the
// reputation sentiment trend rides the velocity weekly series.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
  withTtlCache: async (_key: string, _ttl: number, compute: () => Promise<unknown>) => compute(),
}));

import { getActiveDashboardData } from '../service';

const BUSINESS_ID = 'biz-budget-1';
const BUSINESS_ROW = { name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') };

/** Business identity read + the 10 auxiliary statements of the main wave. */
const MAIN_WAVE_STATEMENTS = 1 + 10;
/** rate, star, timeSaved, pendingApprovalCount — the trend is projected. */
const REPUTATION_STATEMENTS = 4;

let harness: MockSqlHarness;
let mockSql: Sql;

describe('getActiveDashboardData — statement budget per cache miss', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
    harness.sqlReturnQueue.push([BUSINESS_ROW]);
  });

  it('issues exactly 11 statements without reputation metrics', async () => {
    await getActiveDashboardData(mockSql, BUSINESS_ID);
    expect(harness.sqlCalls).toHaveLength(MAIN_WAVE_STATEMENTS);
  });

  it('issues exactly 15 statements with reputation metrics', async () => {
    await getActiveDashboardData(mockSql, BUSINESS_ID, { includeReputationMetrics: true });
    expect(harness.sqlCalls).toHaveLength(MAIN_WAVE_STATEMENTS + REPUTATION_STATEMENTS);
  });

  it('skips the business read when the route pre-fetched the row', async () => {
    harness.resetMockSql();
    await getActiveDashboardData(mockSql, BUSINESS_ID, {
      business: BUSINESS_ROW as never,
      includeReputationMetrics: true,
    });
    expect(harness.sqlCalls).toHaveLength(MAIN_WAVE_STATEMENTS - 1 + REPUTATION_STATEMENTS);
  });

  it('never issues a standalone all-time COUNT(*) or a standalone sentiment-trend series', async () => {
    await getActiveDashboardData(mockSql, BUSINESS_ID, { includeReputationMetrics: true });
    const texts = harness.sqlCalls.map((c) => c.text);
    // The all-time total lives in the GROUP BY star_rating scan as total_count.
    const groupBy = texts.filter((t) => t.includes('GROUP BY star_rating'));
    expect(groupBy).toHaveLength(1);
    expect(groupBy[0]).toContain('total_count');
    // The sentiment trend lives in the weekly series as avg_score.
    const weekly = texts.filter((t) => t.includes('AVG(sentiment_score)'));
    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toContain('COALESCE(r.cnt, 0)');
  });
});
