import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

// aggregate-service is born-injected (sql is a parameter), so @/lib/db/server is
// not mocked here — the fragment-aware createMockSql harness stands in for `sql`
// directly. The set-based aggregate wave is mocked at the seam
// (fetchPerLocationAggregateSlices); the service under test is now a pure
// composition of slices → AggregateDashboardData.

const { mockFetchSlices } = vi.hoisted(() => ({
  mockFetchSlices: vi.fn(),
}));
vi.mock('@/lib/dashboard/aggregate-queries', () => ({
  fetchPerLocationAggregateSlices: (...args: unknown[]) => mockFetchSlices(...args),
}));

// The aggregate payload is cached in Redis (45s TTL). Stub the cache as
// always-miss so every test exercises a fresh computation.
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: async () => null,
    set: async () => 'OK',
  }),
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: vi.fn(async () => [
    { id: 'loc-1', account_id: 'acc-1', name: 'Downtown Cafe', display_label: 'Downtown', is_primary: true, archived_at: null, google_place_id: 'g1', google_place_address: null, created_at: new Date('2026-01-01') },
    { id: 'loc-2', account_id: 'acc-1', name: 'Westside Bakery', display_label: null, is_primary: false, archived_at: null, google_place_id: 'g2', google_place_address: null, created_at: new Date('2026-01-02') },
  ]),
}));

// Import AFTER mocks are set up.
import { getAggregateDashboardData } from '../aggregate-service';
import { authoritativePendingCount } from '../scope';
import { buildRatingBreakdown } from '../rating-breakdown';
import type { PerLocationAggregateSlice } from '../aggregate-queries';
import type { RatingBreakdown } from '../types';

let harness: MockSqlHarness;
let mockSql: Sql;

/** A per-location aggregate slice with sensible defaults; override per test. */
function makeSlice(overrides: Partial<PerLocationAggregateSlice> = {}): PerLocationAggregateSlice {
  return {
    valueSummary: {
      totalReviewsHandled: 0,
      totalTimeSavedMinutes: 0,
      currentResponseRate: 0,
      baselineResponseRate: null,
    },
    reviewVelocity: [],
    ranking: null,
    ratingBreakdown: buildRatingBreakdown([]),
    latestBrief: null,
    recentReviewCount: 0,
    pendingApprovalCount: 0,
    windowedReceived: 0,
    windowedResponded: 0,
    ...overrides,
  };
}

const MONTHLY_BRIEF = { text: 'Monthly A', type: 'monthly' as const, periodLabel: 'June 2026' };

/** Two-location fixture used across the byte-identical + windowed-rate cases. */
function twoLocationSlices(ratingA?: RatingBreakdown, ratingB?: RatingBreakdown): Map<string, PerLocationAggregateSlice> {
  return new Map<string, PerLocationAggregateSlice>([
    ['loc-1', makeSlice({
      valueSummary: { totalReviewsHandled: 40, totalTimeSavedMinutes: 280, currentResponseRate: 80, baselineResponseRate: 30 },
      reviewVelocity: [{ weekStart: '2026-06-01', count: 2 }, { weekStart: '2026-06-08', count: 3 }],
      ranking: [{ keyword: 'coffee', snapshots: [{ date: '2026-06-01', position: 3 }, { date: '2026-06-08', position: 2 }] }],
      ratingBreakdown: ratingA ?? buildRatingBreakdown([{ stars: 5, count: 2 }, { stars: 1, count: 1 }]),
      latestBrief: MONTHLY_BRIEF,
      recentReviewCount: 2,
      pendingApprovalCount: 25,
      windowedReceived: 12,
      windowedResponded: 9,
    })],
    ['loc-2', makeSlice({
      valueSummary: { totalReviewsHandled: 10, totalTimeSavedMinutes: 70, currentResponseRate: 50, baselineResponseRate: 20 },
      reviewVelocity: [{ weekStart: '2026-06-01', count: 1 }, { weekStart: '2026-06-08', count: 4 }],
      ranking: [{ keyword: 'coffee', snapshots: [{ date: '2026-06-01', position: 2 }, { date: '2026-06-08', position: 5 }] }],
      ratingBreakdown: ratingB ?? buildRatingBreakdown([{ stars: 5, count: 3 }, { stars: 4, count: 4 }]),
      latestBrief: null,
      recentReviewCount: 2,
      pendingApprovalCount: 13,
      windowedReceived: 8,
      windowedResponded: 5,
    })],
  ]);
}

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
  mockFetchSlices.mockReset();
  // sql call order: [account billing row, account-wide recent-reviews feed].
  harness.sqlReturnQueue.push([{ locations_included: 5, locations_paid: 0 }], []);
});

describe('getAggregateDashboardData — byte-identical composition from slices', () => {
  beforeEach(() => {
    mockFetchSlices.mockResolvedValue(twoLocationSlices());
  });

  it('sums value summary, merges velocity/ranking, and rolls up briefs', async () => {
    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.valueSummary.totalReviewsHandled).toBe(50);
    expect(result.valueSummary.totalTimeSavedMinutes).toBe(350);
    expect(result.valueSummary.baselineResponseRate).toBe(30); // primary (loc-1)

    // Velocity: per-week sum across locations.
    expect(result.reviewVelocity).toEqual([
      { weekStart: '2026-06-01', count: 3 },
      { weekStart: '2026-06-08', count: 7 },
    ]);

    // Ranking: best (lowest) position across locations per keyword/date.
    expect(result.ranking).toEqual([
      { keyword: 'coffee', snapshots: [
        { date: '2026-06-01', position: 2 },
        { date: '2026-06-08', position: 2 },
      ] },
    ]);

    // Briefs roll up only locations that have one.
    expect(result.perLocationBriefs).toEqual([
      { locationId: 'loc-1', displayName: 'Downtown', brief: MONTHLY_BRIEF },
    ]);

    expect(result.activeLocationCount).toBe(2);
    expect(mockFetchSlices).toHaveBeenCalledWith(expect.any(Function), 'acc-1', '30d');
  });

  it('builds locationKpis from the slice (pending is authoritative, not the capped recentReviewCount)', async () => {
    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    const loc1 = result.locationKpis.find((k) => k.locationId === 'loc-1');
    const loc2 = result.locationKpis.find((k) => k.locationId === 'loc-2');
    expect(loc1).toMatchObject({ displayName: 'Downtown', isPrimary: true, totalReviewsHandled: 40, pendingApprovalCount: 25, recentReviewCount: 2, billingPending: false });
    expect(loc2).toMatchObject({ displayName: 'Westside Bakery', isPrimary: false, totalReviewsHandled: 10, pendingApprovalCount: 13, recentReviewCount: 2, billingPending: false });
    // pending (25/13) diverges from the capped recentReviewCount (2) — proving it
    // is NOT derived from the displayed slice (#346).
    expect(loc1!.pendingApprovalCount).not.toBe(loc1!.recentReviewCount);
  });

  it('aggregate badge total sums the authoritative per-location counts (>10 regression, #346)', async () => {
    const result = await getAggregateDashboardData(mockSql, 'acc-1');
    expect(authoritativePendingCount(result)).toBe(38); // 25 + 13, not 2 + 2
  });

  it('does not expose partialFailures on the returned payload', async () => {
    const result = await getAggregateDashboardData(mockSql, 'acc-1');
    expect('partialFailures' in result).toBe(false);
  });
});

describe('getAggregateDashboardData — windowed currentResponseRate', () => {
  it('derives from summed windowedResponded / windowedReceived (NOT all-time)', async () => {
    mockFetchSlices.mockResolvedValue(twoLocationSlices());
    const result = await getAggregateDashboardData(mockSql, 'acc-1');
    // windowedResponded 9+5=14 over windowedReceived 12+8=20 → 70%.
    expect(result.valueSummary.currentResponseRate).toBe(70);
  });

  it('is 0 when the window received no reviews', async () => {
    mockFetchSlices.mockResolvedValue(new Map<string, PerLocationAggregateSlice>([
      ['loc-1', makeSlice({ valueSummary: { totalReviewsHandled: 5, totalTimeSavedMinutes: 35, currentResponseRate: 100, baselineResponseRate: null }, windowedReceived: 0, windowedResponded: 0 })],
      ['loc-2', makeSlice({ windowedReceived: 0, windowedResponded: 0 })],
    ]));
    const result = await getAggregateDashboardData(mockSql, 'acc-1');
    expect(result.valueSummary.currentResponseRate).toBe(0);
  });
});

describe('getAggregateDashboardData — ratingBreakdown rollup (#405)', () => {
  it('sums the per-location windowed breakdowns into one account-wide breakdown', async () => {
    mockFetchSlices.mockResolvedValue(twoLocationSlices());
    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.ratingBreakdown.counts).toEqual([
      { stars: 5, count: 5 }, // 2 + 3
      { stars: 4, count: 4 }, // 0 + 4
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 1 }, // 1 + 0
    ]);
    expect(result.ratingBreakdown.total).toBe(10);
  });
});

describe('getAggregateDashboardData — recent-reviews feed (unchanged)', () => {
  it('preserves scheduled-post and open-escalation fields from the account-wide feed', async () => {
    mockFetchSlices.mockResolvedValue(twoLocationSlices());
    // Override the recent-reviews return (2nd sql call after the billing row).
    harness.sqlReturnQueue.length = 0;
    harness.sqlReturnQueue.push(
      [{ locations_included: 5, locations_paid: 0 }],
      ['loc-1', 'loc-2'].map((locationId, index) => ({
        id: `rev-${index}`,
        reviewer_name: 'Reviewer',
        star_rating: 5,
        review_text: null,
        review_date: '2026-06-01',
        status: 'pending_approval',
        response_text: 'draft',
        response_status: 'pending_approval',
        approval_method: null,
        auto_post_scheduled_at: '2026-07-13T18:00:00.000Z',
        escalation_id: 'escalation-open-1',
        escalation_status: 'escalated',
        escalation_severity: 'high',
        location_id: locationId,
        location_name: locationId === 'loc-1' ? 'Downtown Cafe' : 'Westside Bakery',
        location_display_label: locationId === 'loc-1' ? 'Downtown' : null,
      })),
    );

    const result = await getAggregateDashboardData(mockSql, 'acc-1');

    expect(result.recentReviews).toHaveLength(2);
    for (const review of result.recentReviews) {
      expect(review.autoPostScheduledAt).toBe('2026-07-13T18:00:00.000Z');
      expect(review.escalation).toEqual({ id: 'escalation-open-1', status: 'escalated', severity: 'high' });
    }
    expect(result.recentReviews.map((r) => r.locationDisplayName).sort()).toEqual(['Downtown', 'Westside Bakery']);
  });
});

describe('getAggregateDashboardData — no active locations', () => {
  it('returns an all-zero payload with no partialFailures', async () => {
    const { getLocationsForAccount } = await import('@/lib/locations/repo');
    vi.mocked(getLocationsForAccount).mockResolvedValueOnce([]);
    harness.resetMockSql();
    harness.sqlReturnQueue.push([{ locations_included: 1, locations_paid: 0 }]);

    const result = await getAggregateDashboardData(mockSql, 'acc-empty');

    expect(result.activeLocationCount).toBe(0);
    expect(result.ratingBreakdown.total).toBe(0);
    expect(result.ratingBreakdown.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
    expect(result.valueSummary.currentResponseRate).toBe(0);
    expect('partialFailures' in result).toBe(false);
    // No slice wave is issued when there are no active locations.
    expect(mockFetchSlices).not.toHaveBeenCalled();
  });
});
