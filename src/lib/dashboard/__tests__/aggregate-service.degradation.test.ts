// P10 (prod-hardening spec, R2/R3), adapted to the #476 set-based shape: the
// aggregate path degrades its OWN independent queries (account billing row,
// account-wide recent-reviews feed) and reports every degradation. The
// locations-list query stays fatal (an aggregate over unknown locations is
// meaningless — the analog of the business lookup), and so does the atomic
// slice wave: it IS the view, and degrading it to empty slices would render
// an all-zeros dashboard that misreports the business.

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

// The real service module (widgetOrFallback) stays live; the set-based
// aggregate wave is stubbed at the seam. Redis is stubbed as always-miss so
// every test exercises a fresh computation and never touches ioredis.
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
  }),
}));

const { mockFetchSlices } = vi.hoisted(() => ({
  mockFetchSlices: vi.fn(),
}));
vi.mock('@/lib/dashboard/aggregate-queries', () => ({
  fetchPerLocationAggregateSlices: (...args: unknown[]) => mockFetchSlices(...args),
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: vi.fn(async () => [
    { id: 'loc-1', account_id: 'acc-1', name: 'Downtown Cafe', display_label: 'Downtown', is_primary: true, archived_at: null, google_place_id: 'g1', google_place_address: null, created_at: new Date('2026-01-01') },
    { id: 'loc-2', account_id: 'acc-1', name: 'Westside Bakery', display_label: null, is_primary: false, archived_at: null, google_place_id: 'g2', google_place_address: null, created_at: new Date('2026-01-01') },
  ]),
}));

import { getAggregateDashboardData } from '../aggregate-service';
import { buildRatingBreakdown } from '../rating-breakdown';
import type { PerLocationAggregateSlice } from '../aggregate-queries';

let harness: MockSqlHarness;
let mockSql: Sql;

function makeSlice(overrides: Partial<PerLocationAggregateSlice> = {}): PerLocationAggregateSlice {
  return {
    valueSummary: {
      totalReviewsHandled: 10,
      totalTimeSavedMinutes: 70,
      currentResponseRate: 80,
      baselineResponseRate: 30,
    },
    reviewVelocity: [],
    ranking: null,
    ratingBreakdown: buildRatingBreakdown([]),
    latestBrief: null,
    recentReviewCount: 0,
    pendingApprovalCount: 0,
    windowedReceived: 10,
    windowedResponded: 8,
    ...overrides,
  };
}

function twoHealthySlices(): Map<string, PerLocationAggregateSlice> {
  return new Map([
    ['loc-1', makeSlice()],
    ['loc-2', makeSlice()],
  ]);
}

/** Rejected promise with a no-op catch already attached, so pushing it into
 *  the mock queue never trips Node's unhandled-rejection detection. */
function preHandledRejection(reason: Error): Promise<never> {
  const rejected = Promise.reject(reason);
  rejected.catch(() => {});
  return rejected;
}

describe('getAggregateDashboardData degradation', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
    mockReportCaughtError.mockReset();
    mockFetchSlices.mockReset();
    mockFetchSlices.mockResolvedValue(twoHealthySlices());
    // sql call order: [account billing row, account-wide recent-reviews feed].
    harness.sqlReturnQueue.push([{ locations_included: 5, locations_paid: 0 }], []);
  });

  it('degrades a failed account billing query to defaults and reports it', async () => {
    harness.resetMockSql();
    harness.sqlReturnQueue.push(
      preHandledRejection(new Error('billing row timeout')),
      [],
    );

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    // Defaults locations_included=1, locations_paid=0 → only the first
    // location is billing-confirmed; the second flags billingPending.
    expect(result.locationKpis.map((k) => k.billingPending)).toEqual([false, true]);
    expect(result.locationKpis).toHaveLength(2); // slices unaffected
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'dashboard/aggregate',
      expect.any(Error),
      expect.objectContaining({
        accountId: 'acc-1',
        widget: 'accountBillingRows',
        degraded: true,
      }),
    );
  });

  it('degrades a failed account-wide recent-reviews feed to an empty feed and reports it', async () => {
    harness.resetMockSql();
    harness.sqlReturnQueue.push(
      [{ locations_included: 5, locations_paid: 0 }],
      preHandledRejection(new Error('recent reviews timeout')),
    );

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.recentReviews).toEqual([]);
    expect(result.locationKpis).toHaveLength(2); // slices unaffected
    expect(result.valueSummary.currentResponseRate).toBe(80); // 16/20 windowed
    expect(mockReportCaughtError).toHaveBeenCalledWith(
      'dashboard/aggregate',
      expect.any(Error),
      expect.objectContaining({
        accountId: 'acc-1',
        widget: 'accountRecentReviews',
        degraded: true,
      }),
    );
  });

  it('keeps the locations-list query fatal', async () => {
    const { getLocationsForAccount } = await import('@/lib/locations/repo');
    vi.mocked(getLocationsForAccount).mockRejectedValueOnce(
      new Error('locations lookup down'),
    );

    await expect(getAggregateDashboardData(mockSql, 'acc-1')).rejects.toThrow(
      'locations lookup down',
    );
  });

  it('keeps the atomic slice wave fatal (an all-zeros aggregate would misreport)', async () => {
    mockFetchSlices.mockRejectedValueOnce(new Error('aggregate wave down'));

    await expect(getAggregateDashboardData(mockSql, 'acc-1')).rejects.toThrow(
      'aggregate wave down',
    );
  });

  it('is unchanged when everything is healthy', async () => {
    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.valueSummary.currentResponseRate).toBe(80); // 16/20 windowed
    expect(result.locationKpis).toHaveLength(2);
    expect(result.locationKpis.map((k) => k.billingPending)).toEqual([false, false]);
    expect(mockReportCaughtError).not.toHaveBeenCalled();
  });
});
