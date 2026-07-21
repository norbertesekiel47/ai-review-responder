// P10 (prod-hardening spec, R2/R3) on the #476 set-based shape, revised by
// adversarial finding 2: the slice wave is NOT an atomic unit — it is ~8
// independent reads, and each degrades PER-QUERY via widgetOrFallback so one
// ranking/brief/counter read timing out empties that widget column across
// locations instead of 500ing the whole multi-location dashboard. Exactly two
// reads stay fatal: the locations-list query (an aggregate over unknown
// locations is meaningless) and the wave's baseline anchor read (the slices
// are built by iterating its rows — degrading it would render an all-zeros
// dashboard that misreports the business). Every degradation reports.
//
// The REAL aggregate-queries module runs here (no seam mock): rejections are
// injected per-query through the shared mock-sql FIFO, so these tests prove
// the degradation end-to-end through getAggregateDashboardData.

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

// The real service module (widgetOrFallback) stays live; Redis is stubbed as
// always-miss so every test exercises a fresh computation and never touches
// ioredis.
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
  }),
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: vi.fn(async () => [
    { id: 'loc-1', account_id: 'acc-1', name: 'Downtown Cafe', display_label: 'Downtown', is_primary: true, archived_at: null, google_place_id: 'g1', google_place_address: null, created_at: new Date('2026-01-01') },
    { id: 'loc-2', account_id: 'acc-1', name: 'Westside Bakery', display_label: null, is_primary: false, archived_at: null, google_place_id: 'g2', google_place_address: null, created_at: new Date('2026-01-01') },
  ]),
}));

import { getAggregateDashboardData } from '../aggregate-service';

let harness: MockSqlHarness;
let mockSql: Sql;

/** Rejected promise with a no-op catch already attached, so pushing it into
 *  the mock queue never trips Node's unhandled-rejection detection. */
function preHandledRejection(reason: Error): Promise<never> {
  const rejected = Promise.reject(reason);
  rejected.catch(() => {});
  return rejected;
}

/**
 * Deterministic FIFO order of the 10 SQL results one getAggregateDashboardData
 * call consumes (same thenable-adoption reasoning as aggregate-queries.test.ts's
 * pushWave):
 *   1. account billing row               (aggregate-service, settled)
 *   2. pending-approval counts           (async helper awaits its sql first)
 *   3. baseline anchor                   (wave — FATAL)
 *   4. review counters                   (wave, degradable)
 *   5. review velocity                   (wave, degradable)
 *   6. rating breakdown                  (wave, degradable)
 *   7. ranking snapshots                 (wave, degradable)
 *   8. latest monthly briefs             (wave, degradable)
 *   9. latest weekly briefs              (wave, degradable)
 *  10. account-wide recent reviews feed  (aggregate-service, settled)
 */
function pushDashboardQueries(overrides: Partial<Record<
  'billing' | 'pending' | 'baseline' | 'counters' | 'velocity' | 'rating' | 'ranking' | 'monthly' | 'weekly' | 'recent',
  unknown
>> = {}): void {
  harness.sqlReturnQueue.push(
    overrides.billing ?? [{ locations_included: 5, locations_paid: 0 }],
    overrides.pending ?? [
      { business_id: 'loc-1', count: 3 },
      { business_id: 'loc-2', count: 1 },
    ],
    overrides.baseline ?? [
      { business_id: 'loc-1', name: 'Downtown Cafe', created_at: new Date('2026-01-01'), initial_review_count: 100, initial_responded_count: 30, baseline_captured_at: new Date('2026-01-05') },
      { business_id: 'loc-2', name: 'Westside Bakery', created_at: new Date('2026-01-01'), initial_review_count: null, initial_responded_count: null, baseline_captured_at: null },
    ],
    overrides.counters ?? [
      { business_id: 'loc-1', total_received_all_time: 12, total_responded_all_time: 10, received_window: 10, responded_window: 8 },
      { business_id: 'loc-2', total_received_all_time: 12, total_responded_all_time: 10, received_window: 10, responded_window: 8 },
    ],
    overrides.velocity ?? [],
    overrides.rating ?? [
      { business_id: 'loc-1', stars: 5, count: 2 },
    ],
    overrides.ranking ?? [],
    overrides.monthly ?? [
      { business_id: 'loc-1', summary_text: 'Monthly A', month_start_date: '2026-06-01', sent_at: '2026-07-01T00:00:00Z' },
    ],
    overrides.weekly ?? [],
    overrides.recent ?? [],
  );
}

function expectDegradationReported(widget: string): void {
  expect(mockReportCaughtError).toHaveBeenCalledWith(
    'dashboard/aggregate',
    expect.any(Error),
    expect.objectContaining({
      accountId: 'acc-1',
      widget,
      degraded: true,
    }),
  );
}

describe('getAggregateDashboardData degradation', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
    mockReportCaughtError.mockReset();
  });

  it('degrades a failed account billing query to defaults and reports it', async () => {
    pushDashboardQueries({ billing: preHandledRejection(new Error('billing row timeout')) });

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    // Defaults locations_included=1, locations_paid=0 → only the first
    // location is billing-confirmed; the second flags billingPending.
    expect(result.locationKpis.map((k) => k.billingPending)).toEqual([false, true]);
    expect(result.locationKpis).toHaveLength(2); // slices unaffected
    expectDegradationReported('accountBillingRows');
  });

  it('degrades a failed account-wide recent-reviews feed to an empty feed and reports it', async () => {
    pushDashboardQueries({ recent: preHandledRejection(new Error('recent reviews timeout')) });

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.recentReviews).toEqual([]);
    expect(result.locationKpis).toHaveLength(2); // slices unaffected
    expect(result.valueSummary.currentResponseRate).toBe(80); // 16/20 windowed
    expectDegradationReported('accountRecentReviews');
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

  it('keeps the baseline anchor read fatal (the slices are built from its rows — an all-zeros aggregate would misreport)', async () => {
    pushDashboardQueries({ baseline: preHandledRejection(new Error('baseline anchor down')) });

    await expect(getAggregateDashboardData(mockSql, 'acc-1')).rejects.toThrow(
      'baseline anchor down',
    );
  });

  it('degrades a failed counters read to zeroed value summaries and reports it', async () => {
    pushDashboardQueries({ counters: preHandledRejection(new Error('counters timeout')) });

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.valueSummary).toMatchObject({
      totalReviewsHandled: 0,
      totalTimeSavedMinutes: 0,
      currentResponseRate: 0,
    });
    expect(result.locationKpis).toHaveLength(2); // dashboard still renders
    // Other widgets survive: pending counts came from their own read.
    expect(result.locationKpis.map((k) => k.pendingApprovalCount)).toEqual([3, 1]);
    expectDegradationReported('sliceReviewCounters');
  });

  it('degrades a failed velocity read to empty velocity and reports it', async () => {
    pushDashboardQueries({ velocity: preHandledRejection(new Error('velocity timeout')) });

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.reviewVelocity).toEqual([]);
    expect(result.perLocationVelocity.map((v) => v.velocity)).toEqual([[], []]);
    expect(result.valueSummary.currentResponseRate).toBe(80); // counters survive
    expectDegradationReported('sliceReviewVelocity');
  });

  it('degrades a failed rating-breakdown read to a zero breakdown and reports it', async () => {
    pushDashboardQueries({ rating: preHandledRejection(new Error('rating timeout')) });

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.ratingBreakdown.total).toBe(0);
    expect(result.locationKpis).toHaveLength(2);
    expectDegradationReported('sliceRatingBreakdown');
  });

  it('degrades a failed ranking read to null ranking and reports it', async () => {
    pushDashboardQueries({ ranking: preHandledRejection(new Error('ranking timeout')) });

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.ranking).toBeNull();
    expect(result.perLocationRanking).toEqual([]);
    expect(result.valueSummary.currentResponseRate).toBe(80); // counters survive
    expectDegradationReported('sliceRanking');
  });

  it('degrades failed brief reads to no briefs and reports each', async () => {
    pushDashboardQueries({
      monthly: preHandledRejection(new Error('monthly briefs timeout')),
      weekly: preHandledRejection(new Error('weekly briefs timeout')),
    });

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.perLocationBriefs).toEqual([]);
    expect(result.locationKpis).toHaveLength(2);
    expectDegradationReported('sliceMonthlyBriefs');
    expectDegradationReported('sliceWeeklyBriefs');
  });

  it('degrades a failed pending-approval-counts read to zero counts and reports it', async () => {
    pushDashboardQueries({ pending: preHandledRejection(new Error('pending counts timeout')) });

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.locationKpis.map((k) => k.pendingApprovalCount)).toEqual([0, 0]);
    expect(result.valueSummary.currentResponseRate).toBe(80); // counters survive
    expectDegradationReported('slicePendingApprovalCounts');
  });

  it('is unchanged when everything is healthy', async () => {
    pushDashboardQueries();

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.valueSummary.currentResponseRate).toBe(80); // 16/20 windowed
    expect(result.valueSummary.totalReviewsHandled).toBe(20);
    expect(result.valueSummary.baselineResponseRate).toBe(30); // primary loc-1
    expect(result.locationKpis).toHaveLength(2);
    expect(result.locationKpis.map((k) => k.billingPending)).toEqual([false, false]);
    expect(result.locationKpis.map((k) => k.pendingApprovalCount)).toEqual([3, 1]);
    expect(result.ratingBreakdown.total).toBe(2);
    expect(result.perLocationBriefs).toHaveLength(1);
    expect(mockReportCaughtError).not.toHaveBeenCalled();
  });
});
