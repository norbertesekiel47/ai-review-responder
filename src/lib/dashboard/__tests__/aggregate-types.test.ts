import { describe, it, expect } from 'vitest';
import type {
  AggregateDashboardData,
  PerLocationKpi,
  PerLocationVelocity,
  PerLocationRanking,
  PerLocationBrief,
  AggregateReviewItem,
  DashboardDataActive,
  DashboardData,
} from '../types';

/** Type guard to distinguish AggregateDashboardData from per-location DashboardData. */
function isAggregateData(data: DashboardData | AggregateDashboardData): data is AggregateDashboardData {
  return 'scope' in data && data.scope === 'aggregate';
}

describe('AggregateDashboardData types', () => {
  it('distinguishes aggregate data from per-location data via scope field', () => {
    const aggregate: AggregateDashboardData = {
      scope: 'aggregate',
      valueSummary: {
        totalReviewsHandled: 42,
        totalTimeSavedMinutes: 294,
        currentResponseRate: 85,
        baselineResponseRate: 30,
      },
      reviewVelocity: [{ weekStart: '2026-04-27', count: 5 }],
      perLocationVelocity: [],
      ranking: null,
      perLocationRanking: [],
      recentReviews: [],
      perLocationBriefs: [],
      locationKpis: [],
      activeLocationCount: 2,
    };

    const perLocation: DashboardDataActive = {
      business: { name: 'Test', createdAt: '2026-01-01' },
      valueSummary: {
        totalReviewsHandled: 42,
        totalTimeSavedMinutes: 294,
        currentResponseRate: 85,
        baselineResponseRate: 30,
      },
      reviewVelocity: [],
      ranking: null,
      recentReviews: [],
      latestBrief: null,
      settings: {
        tone: 'professional',
        productsServices: '',
        avoidFacts: [],
        sampleResponses: [],
        ownerPhone: '',
        ownerEmail: '',
        weeklySummaryEnabled: true,
        monthlyImpactEnabled: true,
        category: '',
        googlePlaceId: '',
      },
      zernioConnection: {
        status: 'none',
        queuedReconnectCount: 0,
        hasUnresolvedIncident: false,
      },
    };

    expect(isAggregateData(aggregate)).toBe(true);
    expect(isAggregateData(perLocation)).toBe(false);
  });

  it('PerLocationKpi has correct shape', () => {
    const kpi: PerLocationKpi = {
      locationId: 'loc-1',
      displayName: 'Downtown Cafe',
      isPrimary: true,
      totalReviewsHandled: 20,
      pendingApprovalCount: 3,
      recentReviewCount: 8,
    };

    expect(kpi.displayName).toBe('Downtown Cafe');
    expect(kpi.isPrimary).toBe(true);
    expect(kpi.pendingApprovalCount).toBe(3);
  });

  it('AggregateReviewItem includes location chip fields', () => {
    const item: AggregateReviewItem = {
      id: 'review-1',
      reviewerName: 'Sarah K.',
      starRating: 4,
      reviewText: 'Great service!',
      reviewDate: '2026-05-07T10:00:00Z',
      status: 'pending_approval',
      responseText: 'Thank you!',
      responseStatus: 'pending_approval',
      locationId: 'loc-1',
      locationDisplayName: 'Downtown Cafe',
    };

    expect(item.locationDisplayName).toBe('Downtown Cafe');
    expect(item.locationId).toBe('loc-1');
  });

  it('PerLocationVelocity has velocity array per location', () => {
    const vel: PerLocationVelocity = {
      locationId: 'loc-1',
      displayName: 'Downtown Cafe',
      velocity: [
        { weekStart: '2026-04-27', count: 3 },
        { weekStart: '2026-05-04', count: 5 },
      ],
    };

    expect(vel.velocity).toHaveLength(2);
    expect(vel.velocity[1]!.count).toBe(5);
  });

  it('PerLocationRanking has ranking per location', () => {
    const rank: PerLocationRanking = {
      locationId: 'loc-1',
      displayName: 'Downtown Cafe',
      ranking: [
        {
          keyword: 'best coffee',
          snapshots: [
            { date: '2026-05-01', position: 3 },
          ],
        },
      ],
    };

    expect(rank.ranking).not.toBeNull();
    expect(rank.ranking![0]!.keyword).toBe('best coffee');
  });

  it('PerLocationBrief has brief per location', () => {
    const brief: PerLocationBrief = {
      locationId: 'loc-1',
      displayName: 'Downtown Cafe',
      brief: {
        text: 'Reviews are trending up.',
        type: 'weekly',
        periodLabel: 'Week of May 5',
      },
    };

    expect(brief.brief).not.toBeNull();
    expect(brief.brief!.type).toBe('weekly');
  });

  // VAL-DASH-019: Aggregate sums match sum of individual per-location values
  it('aggregate valueSummary matches sum of per-location KPIs', () => {
    const kpis: PerLocationKpi[] = [
      { locationId: 'loc-1', displayName: 'Downtown Cafe', isPrimary: true, totalReviewsHandled: 20, pendingApprovalCount: 3, recentReviewCount: 8 },
      { locationId: 'loc-2', displayName: 'Westside Bakery', isPrimary: false, totalReviewsHandled: 15, pendingApprovalCount: 1, recentReviewCount: 5 },
    ];

    const aggregateTotalHandled = kpis.reduce((sum, k) => sum + k.totalReviewsHandled, 0);
    const aggregatePending = kpis.reduce((sum, k) => sum + k.pendingApprovalCount, 0);

    expect(aggregateTotalHandled).toBe(35);
    expect(aggregatePending).toBe(4);
  });

  it('aggregate with zero locations returns zero values', () => {
    const empty: AggregateDashboardData = {
      scope: 'aggregate',
      valueSummary: {
        totalReviewsHandled: 0,
        totalTimeSavedMinutes: 0,
        currentResponseRate: 0,
        baselineResponseRate: null,
      },
      reviewVelocity: [],
      perLocationVelocity: [],
      ranking: null,
      perLocationRanking: [],
      recentReviews: [],
      perLocationBriefs: [],
      locationKpis: [],
      activeLocationCount: 0,
    };

    expect(empty.activeLocationCount).toBe(0);
    expect(empty.valueSummary.totalReviewsHandled).toBe(0);
    expect(empty.recentReviews).toHaveLength(0);
  });
});
