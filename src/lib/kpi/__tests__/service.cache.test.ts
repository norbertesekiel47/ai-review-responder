// Cache behavior for getLocationKpiSummary/getAccountKpiSummary (T1, #478).
//
// The 45s fail-open Upstash read cache mirrors the #487 aggregate-service
// block. These tests drive the cache seam directly via vi.hoisted mock fns
// for get/set, and use the fragment-aware createMockSql harness (see
// service.test.ts) to prove HITs issue ZERO SQL and MISSes compute + write.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

const { getMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn<(key: string) => Promise<string | null>>(),
  setMock: vi.fn<(...args: unknown[]) => Promise<string>>(),
}));

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: getMock, set: setMock }),
}));

import { getAccountKpiSummary, getLocationKpiSummary } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;

/**
 * Mirrors the seed helper in service.test.ts: the five KPI queries run via
 * Promise.all in a fixed order (rate, star, volume, ttr, trend).
 */
function seed(opts: {
  received?: number; handled?: number; avgStar?: number | null;
  current?: number; prior?: number; avgHours?: number | null;
  trend?: Array<{ week_start: string; avg_score: number | null; cnt: number }>;
} = {}) {
  harness.sqlReturnQueue.push([{ received: opts.received ?? 0, handled: opts.handled ?? 0 }]);
  harness.sqlReturnQueue.push([{ avg: opts.avgStar ?? null }]);
  harness.sqlReturnQueue.push([{ current_month: opts.current ?? 0, prior_month: opts.prior ?? 0 }]);
  harness.sqlReturnQueue.push([{ avg_hours: opts.avgHours ?? null }]);
  harness.sqlReturnQueue.push(opts.trend ?? []);
}

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  getMock.mockReset();
  setMock.mockReset();
  // Default: cache miss + successful write. Individual tests override.
  getMock.mockResolvedValue(null);
  setMock.mockResolvedValue('OK');
});

describe('getLocationKpiSummary cache', () => {
  it('HIT: returns the cached summary and issues ZERO SQL queries', async () => {
    const cachedSummary = {
      scope: { kind: 'location', businessId: 'biz-1' },
      windowDays: 30,
      responseRate: { handled: 8, received: 10, ratePct: 80 },
      averageStarRating: 4.5,
      reviewVolume: { currentMonth: 12, priorMonth: 8, deltaPct: 50 },
      averageTimeToRespondHours: 2.1,
      sentimentTrend: [],
    };
    getMock.mockResolvedValueOnce(JSON.stringify(cachedSummary));

    const summary = await getLocationKpiSummary(mockSql, 'biz-1');

    expect(summary).toEqual(cachedSummary);
    expect(harness.sqlCalls).toHaveLength(0);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('MISS: computes fresh, then writes the summary under the location key with EX 45', async () => {
    seed({ received: 10, handled: 8 });

    const summary = await getLocationKpiSummary(mockSql, 'biz-1');

    expect(getMock).toHaveBeenCalledWith('kpi:location:biz-1:30d');
    expect(harness.sqlCalls).toHaveLength(5);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      'kpi:location:biz-1:30d',
      JSON.stringify(summary),
      'EX',
      45,
    );
  });

  it('GET throws: fails open and computes fresh (no throw)', async () => {
    getMock.mockRejectedValueOnce(new Error('redis down'));
    seed({ received: 4, handled: 2 });

    const summary = await getLocationKpiSummary(mockSql, 'biz-1');

    expect(summary.responseRate).toEqual({ handled: 2, received: 4, ratePct: 50 });
    expect(harness.sqlCalls).toHaveLength(5);
  });

  it('SET throws: returns the fresh result (no throw)', async () => {
    setMock.mockRejectedValueOnce(new Error('redis down'));
    seed({ received: 6, handled: 3 });

    const summary = await getLocationKpiSummary(mockSql, 'biz-1');

    expect(summary.responseRate).toEqual({ handled: 3, received: 6, ratePct: 50 });
    expect(harness.sqlCalls).toHaveLength(5);
  });
});

describe('getAccountKpiSummary cache', () => {
  it('HIT: returns the cached summary and issues ZERO SQL queries', async () => {
    const cachedSummary = {
      scope: { kind: 'account', accountId: 'acct-1' },
      windowDays: 30,
      responseRate: { handled: 15, received: 20, ratePct: 75 },
      averageStarRating: 4.2,
      reviewVolume: { currentMonth: 9, priorMonth: 6, deltaPct: 50 },
      averageTimeToRespondHours: 2.0,
      sentimentTrend: [],
    };
    getMock.mockResolvedValueOnce(JSON.stringify(cachedSummary));

    const summary = await getAccountKpiSummary(mockSql, 'acct-1');

    expect(summary).toEqual(cachedSummary);
    expect(harness.sqlCalls).toHaveLength(0);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('MISS: writes under the account key with EX 45', async () => {
    seed({ received: 20, handled: 15 });

    const summary = await getAccountKpiSummary(mockSql, 'acct-1');

    expect(getMock).toHaveBeenCalledWith('kpi:account:acct-1:30d');
    expect(harness.sqlCalls).toHaveLength(5);
    expect(setMock).toHaveBeenCalledWith(
      'kpi:account:acct-1:30d',
      JSON.stringify(summary),
      'EX',
      45,
    );
  });
});

describe('cache key distinctness', () => {
  it('location and account scopes use different key namespaces', async () => {
    seed();
    await getLocationKpiSummary(mockSql, 'id-1');
    seed();
    await getAccountKpiSummary(mockSql, 'id-1');

    expect(getMock).toHaveBeenNthCalledWith(1, 'kpi:location:id-1:30d');
    expect(getMock).toHaveBeenNthCalledWith(2, 'kpi:account:id-1:30d');
  });

  it('two different windows produce different keys', async () => {
    seed();
    await getLocationKpiSummary(mockSql, 'biz-1', '7d');
    seed();
    await getLocationKpiSummary(mockSql, 'biz-1', '90d');

    expect(getMock).toHaveBeenNthCalledWith(1, 'kpi:location:biz-1:7d');
    expect(getMock).toHaveBeenNthCalledWith(2, 'kpi:location:biz-1:90d');
  });
});
