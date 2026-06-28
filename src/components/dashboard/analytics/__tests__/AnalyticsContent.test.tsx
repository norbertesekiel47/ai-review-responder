// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { useDashboardDataMock } = vi.hoisted(() => ({
  useDashboardDataMock: vi.fn(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: () => useDashboardDataMock(),
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: 'loc-1' }),
}));
vi.mock('@/contexts/PendingCountContext', () => ({
  useSetPendingCount: () => () => {},
}));
vi.mock('@/components/dashboard/shell/TopBar', () => ({
  TopBar: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { AnalyticsContent } from '@/components/dashboard/analytics/AnalyticsContent';

const weeks = (counts: number[]) =>
  counts.map((count, i) => ({ weekStart: `2026-04-${String(i + 1).padStart(2, '0')}`, count }));

const ratings = (stars: Array<number | null>) =>
  stars.map((starRating, i) => ({ id: `r${i}`, starRating, status: 'posted' }));

const baseActive = {
  business: { name: 'Biz', createdAt: '2026-01-01' },
  valueSummary: { totalReviewsHandled: 9, totalTimeSavedMinutes: 54, currentResponseRate: 90, baselineResponseRate: null },
  reputationSummary: {
    averageStar: { current: 4.8, delta: 0.5, priorSampleSize: 5 },
    responseRate: { current: 90, delta: 5, priorSampleSize: 5 },
    timeSavedMinutes: { current: 54, delta: 10, priorSampleSize: 5 },
    pendingApprovalCount: 0,
    trend: [
      { weekStart: '2026-04-01', starEquivalent: 4.3, reviewCount: 4 },
      { weekStart: '2026-04-08', starEquivalent: 4.8, reviewCount: 4 },
    ],
    isRamping: false,
  },
  reviewVelocity: weeks([2, 5]),
  ranking: [
    {
      keyword: 'cafe near me',
      snapshots: [
        { date: '2026-05-01', position: 5 },
        { date: '2026-06-01', position: 3 },
      ],
    },
  ],
  recentReviews: [],
  latestBrief: null,
  zernioConnection: { status: 'active', queuedReconnectCount: 0, hasUnresolvedIncident: false },
};

const baseAggregate = {
  scope: 'aggregate',
  valueSummary: { totalReviewsHandled: 20, totalTimeSavedMinutes: 120, currentResponseRate: 88, baselineResponseRate: null },
  reviewVelocity: weeks([3, 6]),
  perLocationVelocity: [],
  ranking: [{ keyword: 'best cafe', snapshots: [{ date: '2026-06-01', position: 2 }] }],
  perLocationRanking: [],
  recentReviews: [],
  perLocationBriefs: [],
  locationKpis: [],
  activeLocationCount: 2,
};

describe('AnalyticsContent', () => {
  it('leads the per-location grid with the reputation KPI strip, then the three charts', () => {
    useDashboardDataMock.mockReturnValue({ data: baseActive, error: null, loading: false, refresh: vi.fn() });
    render(<AnalyticsContent />);

    // KPI strip (slot 1) — ReputationHeroBand
    expect(screen.getByText('Average rating')).toBeInTheDocument();
    expect(screen.getByText('Response rate')).toBeInTheDocument();

    // Charts
    expect(screen.getByText('Reputation trend')).toBeInTheDocument();
    expect(screen.getByText('Review Velocity')).toBeInTheDocument();
    expect(screen.getByText('Search Ranking')).toBeInTheDocument();

    // Deterministic headlines
    expect(screen.getByText(/Rating climbing/i)).toBeInTheDocument();
    expect(screen.getByText(/Up 150% in new reviews this week/i)).toBeInTheDocument();
    expect(screen.getByText(/Up 2 spots this month/i)).toBeInTheDocument();

    // Breakdown is hidden when no recent review carries a rating
    expect(screen.queryByText('Recent reviews by rating')).not.toBeInTheDocument();
  });

  it('renders the recent rating breakdown when recent reviews carry ratings', () => {
    useDashboardDataMock.mockReturnValue({
      data: { ...baseActive, recentReviews: ratings([5, 5, 4, 3, 1, null]) },
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<AnalyticsContent />);

    expect(screen.getByText('Recent reviews by rating')).toBeInTheDocument();
    // The unrated review is excluded — 5 of 6 count toward the sample.
    expect(screen.getByText(/Based on your 5 most recent reviews/i)).toBeInTheDocument();
    // The paired sentiment-mix card derives from the same recent sample.
    expect(screen.getByText('Sentiment mix')).toBeInTheDocument();
    expect(screen.getByText(/Share of your 5 most recent reviews/i)).toBeInTheDocument();
  });

  it('renders velocity without a ranking card when ranking is null', () => {
    useDashboardDataMock.mockReturnValue({
      data: { ...baseActive, ranking: null },
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<AnalyticsContent />);

    expect(screen.getByText('Review Velocity')).toBeInTheDocument();
    expect(screen.queryByText('Search Ranking')).not.toBeInTheDocument();
  });

  it('renders the aggregate variants with a KPI strip and no per-location trend', () => {
    useDashboardDataMock.mockReturnValue({ data: baseAggregate, error: null, loading: false, refresh: vi.fn() });
    render(<AnalyticsContent />);

    // KPI strip (slot 1) — AggregateKpiCards → ValueKpiGrid
    expect(screen.getByText(/Reviews handled/i)).toBeInTheDocument();

    expect(screen.getByText('Review Velocity')).toBeInTheDocument();
    expect(screen.getByText('Search Ranking')).toBeInTheDocument();
    expect(screen.queryByText('Reputation trend')).not.toBeInTheDocument();
  });

  it('renders the recent rating breakdown in aggregate scope', () => {
    useDashboardDataMock.mockReturnValue({
      data: { ...baseAggregate, recentReviews: ratings([5, 4, 4, 2]) },
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<AnalyticsContent />);

    expect(screen.getByText('Recent reviews by rating')).toBeInTheDocument();
    expect(screen.getByText(/Based on your 4 most recent reviews/i)).toBeInTheDocument();
    expect(screen.getByText('Sentiment mix')).toBeInTheDocument();
  });

  it('shows a loading state', () => {
    useDashboardDataMock.mockReturnValue({ data: null, error: null, loading: true, refresh: vi.fn() });
    render(<AnalyticsContent />);
    expect(screen.getByText(/loading your analytics/i)).toBeInTheDocument();
  });

  it('shows an error state', () => {
    useDashboardDataMock.mockReturnValue({ data: baseAggregate, error: 'boom', loading: false, refresh: vi.fn() });
    render(<AnalyticsContent />);
    expect(screen.getByText(/unable to load analytics/i)).toBeInTheDocument();
    expect(screen.getAllByText('boom').length).toBeGreaterThan(0);
  });

  it('shows an empty state when a young account has no chartable data', () => {
    useDashboardDataMock.mockReturnValue({
      data: { ...baseActive, reputationSummary: { ...baseActive.reputationSummary, trend: [] }, reviewVelocity: [], ranking: null },
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<AnalyticsContent />);
    expect(screen.getByText(/no analytics yet/i)).toBeInTheDocument();
    // The KPI strip stays inside the populated branch, so it should not appear here.
    expect(screen.queryByText('Average rating')).not.toBeInTheDocument();
  });

  it('renders a graceful unavailable state for a non-active subscription', () => {
    useDashboardDataMock.mockReturnValue({
      data: { ...baseActive, subscriptionStatus: 'cancelled' },
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<AnalyticsContent />);
    expect(screen.getByText(/analytics aren't available right now/i)).toBeInTheDocument();
  });
});
