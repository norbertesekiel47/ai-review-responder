import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted shared state ──────────────────────────────────────────────
const { mockSqlResults, sqlCallCounter } = vi.hoisted(() => ({
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
}));

// sql is called 3x inside getAggregateDashboardData (account billing, total
// reviews, total responded). Return queued results by call order.
vi.mock('@/lib/db/server', () => ({
  sql: new Proxy(() => {}, {
    apply: () => {
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }),
}));

const { mockGetActiveDashboardData } = vi.hoisted(() => ({
  mockGetActiveDashboardData: vi.fn(),
}));
vi.mock('@/lib/dashboard/service', () => ({
  getActiveDashboardData: (...args: unknown[]) => mockGetActiveDashboardData(...args),
}));

// The unit under test: the authoritative per-location pending count source.
const { mockGetPendingApprovalCount } = vi.hoisted(() => ({
  mockGetPendingApprovalCount: vi.fn<(businessId: string) => Promise<number>>(),
}));
vi.mock('@/lib/dashboard/pending-count', () => ({
  getPendingApprovalCount: (id: string) => mockGetPendingApprovalCount(id),
}));

vi.mock('@/lib/locations/repo', () => ({
  getLocationsForAccount: vi.fn(async () => [
    { id: 'loc-1', account_id: 'acc-1', name: 'Downtown Cafe', display_label: 'Downtown', is_primary: true, archived_at: null, google_place_id: 'g1', google_place_address: null, created_at: new Date('2026-01-01') },
    { id: 'loc-2', account_id: 'acc-1', name: 'Westside Bakery', display_label: null, is_primary: false, archived_at: null, google_place_id: 'g2', google_place_address: null, created_at: new Date('2026-01-01') },
  ]),
}));

// Import AFTER mocks are set up.
import { getAggregateDashboardData } from '../aggregate-service';
import { authoritativePendingCount } from '../scope';
import { buildRatingBreakdown } from '../rating-breakdown';
import type { DashboardDataActive, RatingBreakdown } from '../types';

/** A per-location dashboard payload whose recentReviews slice has `slicePending`
 *  pending rows — deliberately SMALLER than the authoritative count, to prove
 *  the KPI does not derive from the capped slice. `ratingBreakdown` defaults to
 *  an empty (windowed) breakdown unless a location-specific one is supplied. */
function locationData(
  slicePending: number,
  ratingBreakdown: RatingBreakdown = buildRatingBreakdown([]),
): DashboardDataActive {
  const recentReviews = Array.from({ length: slicePending }, (_, i) => ({
    id: `rev-${i}`,
    reviewerName: 'Reviewer',
    starRating: 5,
    reviewText: null,
    reviewDate: '2026-06-01',
    status: 'pending_approval',
    responseText: 'draft',
    responseStatus: 'pending_approval',
    approvalMethod: null,
  }));
  return {
    business: { name: 'Biz', createdAt: '2026-01-01' },
    valueSummary: {
      totalReviewsHandled: 10,
      totalTimeSavedMinutes: 70,
      currentResponseRate: 80,
      baselineResponseRate: 30,
    },
    ratingBreakdown,
    reviewVelocity: [],
    ranking: null,
    recentReviews,
    latestBrief: null,
    settings: {} as DashboardDataActive['settings'],
    zernioConnection: { status: 'active', queuedReconnectCount: 0, hasUnresolvedIncident: false },
  } as DashboardDataActive;
}

describe('getAggregateDashboardData — authoritative per-location pending count (#346)', () => {
  beforeEach(() => {
    sqlCallCounter.value = 0;
    mockSqlResults.length = 0;
    // sql call order: [account billing, total reviews, total responded]
    mockSqlResults.push(
      [{ locations_included: 5, locations_paid: 0 }],
      [{ count: 100 }],
      [{ count: 80 }],
    );
    mockGetActiveDashboardData.mockReset();
    // Each location's displayed slice has only 2 pending — far below the
    // authoritative counts below — so any derivation from recentReviews fails.
    mockGetActiveDashboardData.mockResolvedValue(locationData(2));
    mockGetPendingApprovalCount.mockReset();
    mockGetPendingApprovalCount.mockImplementation(async (id: string) =>
      id === 'loc-1' ? 25 : 13,
    );
  });

  it('reads locationKpis.pendingApprovalCount from getPendingApprovalCount, not the capped slice', async () => {
    const result = await getAggregateDashboardData('acc-1');

    const loc1 = result.locationKpis.find((k) => k.locationId === 'loc-1');
    const loc2 = result.locationKpis.find((k) => k.locationId === 'loc-2');
    expect(loc1?.pendingApprovalCount).toBe(25);
    expect(loc2?.pendingApprovalCount).toBe(13);
    // recentReviewCount still reflects the displayed slice (2) — proving the two
    // fields diverge and pending is NOT derived from recentReviews.
    expect(loc1?.recentReviewCount).toBe(2);
    expect(mockGetPendingApprovalCount).toHaveBeenCalledWith('loc-1');
    expect(mockGetPendingApprovalCount).toHaveBeenCalledWith('loc-2');
  });

  it('aggregate badge total sums the authoritative per-location counts (>10 regression)', async () => {
    const result = await getAggregateDashboardData('acc-1');
    // 25 + 13 = 38 authoritative — not 2 + 2 = 4 from the capped slices.
    expect(authoritativePendingCount(result)).toBe(38);
  });
});

describe('getAggregateDashboardData — ratingBreakdown (#405)', () => {
  beforeEach(() => {
    sqlCallCounter.value = 0;
    mockSqlResults.length = 0;
    // sql call order: [account billing, total reviews, total responded]
    mockSqlResults.push(
      [{ locations_included: 5, locations_paid: 0 }],
      [{ count: 100 }],
      [{ count: 80 }],
    );
    mockGetPendingApprovalCount.mockReset();
    mockGetPendingApprovalCount.mockResolvedValue(0);
  });

  it('sums the per-location windowed breakdowns into one account-wide breakdown', async () => {
    // getLocationsForAccount (mocked) yields loc-1 + loc-2 of acc-1, so the
    // summed breakdown is tenant-scoped to the account's active locations.
    mockGetActiveDashboardData.mockReset();
    mockGetActiveDashboardData.mockImplementation(async (id: string) =>
      id === 'loc-1'
        ? locationData(0, buildRatingBreakdown([{ stars: 5, count: 2 }, { stars: 1, count: 1 }]))
        : locationData(0, buildRatingBreakdown([{ stars: 5, count: 3 }, { stars: 4, count: 4 }])),
    );

    const result = await getAggregateDashboardData('acc-1');

    expect(result.ratingBreakdown.counts).toEqual([
      { stars: 5, count: 5 },
      { stars: 4, count: 4 },
      { stars: 3, count: 0 },
      { stars: 2, count: 0 },
      { stars: 1, count: 1 },
    ]);
    expect(result.ratingBreakdown.total).toBe(10);
  });
});

describe('getAggregateDashboardData — no active locations', () => {
  beforeEach(() => {
    sqlCallCounter.value = 0;
    mockSqlResults.length = 0;
  });

  it('returns an all-zero rating breakdown when the account has no active locations', async () => {
    const { getLocationsForAccount } = await import('@/lib/locations/repo');
    vi.mocked(getLocationsForAccount).mockResolvedValueOnce([]);
    mockSqlResults.push([{ locations_included: 1, locations_paid: 0 }]);

    const result = await getAggregateDashboardData('acc-empty');

    expect(result.activeLocationCount).toBe(0);
    expect(result.ratingBreakdown.total).toBe(0);
    expect(result.ratingBreakdown.counts.map((c) => c.count)).toEqual([0, 0, 0, 0, 0]);
  });
});
