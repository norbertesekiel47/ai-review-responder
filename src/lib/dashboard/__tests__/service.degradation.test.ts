// P10 (prod-hardening spec): one auxiliary widget query failing must not 500
// the whole dashboard. Only the business lookup stays fatal; every degraded
// widget reports via reportCaughtError — never silently.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';

const { mockReportCaughtError } = vi.hoisted(() => ({
  mockReportCaughtError: vi.fn(),
}));
vi.mock('@/lib/shared/report-caught-error', () => ({
  reportCaughtError: mockReportCaughtError,
}));

// The same stubbed client serves BOTH the payload cache (#495) and the
// pending-marker read; `get` resolving null means cache-miss → fresh compute.
const { mockRedisGet, mockRedisSet } = vi.hoisted(() => ({
  mockRedisGet: vi.fn<() => Promise<string | null>>(),
  mockRedisSet: vi.fn<() => Promise<string>>(),
}));
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: mockRedisGet, set: mockRedisSet }),
  withTtlCache: async (_key: string, _ttl: number, compute: () => Promise<unknown>) => compute(),
}));

import { getActiveDashboardData } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;

const BUSINESS_ID = 'biz-degrade-1';

/** Rejected promise with a no-op catch already attached, so pushing it into
 *  the mock queue never trips Node's unhandled-rejection detection. */
function preHandledRejection(reason: Error): Promise<never> {
  const rejected = Promise.reject(reason);
  rejected.catch(() => {});
  return rejected;
}

/**
 * Seeds all 12 SQL results in source order (business first, then the 11
 * auxiliary queries; the remaining batch slots are the Redis pending marker
 * and the reputation batch — skipped without includeReputationMetrics — not
 * SQL). `rejectAt` replaces one seed with a rejection.
 */
function seedQueries(opts: { rejectAt?: number; reason?: Error } = {}) {
  harness.resetMockSql();
  const results: unknown[] = [
    [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }],
    [{ count: 3 }],
    [{ count: 2 }],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  ];
  if (opts.rejectAt !== undefined) {
    results[opts.rejectAt] = preHandledRejection(opts.reason ?? new Error('boom'));
  }
  harness.sqlReturnQueue.push(...results);
}

describe('getActiveDashboardData degradation', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
    mockReportCaughtError.mockReset();
    mockRedisGet.mockReset();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockReset();
    mockRedisSet.mockResolvedValue('OK');
  });

  it('still returns dashboard data when an auxiliary query rejects, reporting the failure', async () => {
    // Index 4 = ranking_snapshots (0 is the business lookup).
    seedQueries({ rejectAt: 4, reason: new Error('ranking_snapshots timeout') });

    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);

    expect(data.ranking).toBeNull(); // empty fallback shape
    expect(data.valueSummary.totalReviewsHandled).toBe(2); // healthy widgets intact
    expect(mockReportCaughtError).toHaveBeenCalledTimes(1);
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'dashboard/service',
      expect.any(Error),
      expect.objectContaining({
        businessId: BUSINESS_ID,
        widget: 'rankingRows',
        degraded: true,
      }),
    );
  });

  it('still throws when the business query rejects (fatal, fail-fast)', async () => {
    seedQueries({ rejectAt: 0, reason: new Error('pg down') });

    await expect(getActiveDashboardData(mockSql, BUSINESS_ID)).rejects.toThrow(
      'pg down',
    );
  });

  it('still throws BusinessNotFoundError when the business row is missing', async () => {
    seedQueries();
    harness.sqlReturnQueue[0] = [];

    await expect(getActiveDashboardData(mockSql, BUSINESS_ID)).rejects.toThrow(
      `Business not found: ${BUSINESS_ID}`,
    );
  });

  it('renders identically to today when everything succeeds', async () => {
    seedQueries();

    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);

    expect(data.business.name).toBe('Biz');
    expect(data.valueSummary.totalReviewsHandled).toBe(2);
    expect(mockReportCaughtError).not.toHaveBeenCalled();
  });

  it('reports the pending-marker Redis degradation instead of only console-logging it', async () => {
    seedQueries();
    mockRedisGet.mockRejectedValue(new Error('redis unreachable'));

    const data = await getActiveDashboardData(mockSql, BUSINESS_ID);

    expect(data.zernioConnection.status).toBeDefined(); // dashboard still renders
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'dashboard/service',
      expect.any(Error),
      expect.objectContaining({
        businessId: BUSINESS_ID,
        widget: 'pendingMarker',
        degraded: true,
      }),
    );
  });
});
