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
vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/components/dashboard/reviews/ReviewsCard', () => ({
  ReviewsCard: () => <div data-testid="reviews-card" />,
}));
vi.mock('@/components/dashboard/aggregate/AggregateReviewsCard', () => ({
  AggregateReviewsCard: () => <div data-testid="aggregate-reviews-card" />,
}));

import { ReviewsContent } from '@/components/dashboard/reviews/ReviewsContent';

const baseActive = {
  business: { name: 'Biz', createdAt: '2026-01-01' },
  valueSummary: { totalReviewsHandled: 0, totalTimeSavedMinutes: 0, currentResponseRate: 0, baselineResponseRate: null },
  recentReviews: [],
  reviewVelocity: [],
  ranking: null,
  latestBrief: null,
  settings: {},
  zernioConnection: { status: 'active', queuedReconnectCount: 0, hasUnresolvedIncident: false },
};

describe('ReviewsContent', () => {
  it('renders the per-location ReviewsCard for active per-location data', () => {
    useDashboardDataMock.mockReturnValue({ data: baseActive, error: null, loading: false, refresh: vi.fn() });
    render(<ReviewsContent />);
    expect(screen.getByTestId('reviews-card')).toBeInTheDocument();
    expect(screen.queryByTestId('aggregate-reviews-card')).not.toBeInTheDocument();
  });

  it('renders the AggregateReviewsCard for aggregate data', () => {
    useDashboardDataMock.mockReturnValue({
      data: { scope: 'aggregate', recentReviews: [], isReadOnly: false },
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<ReviewsContent />);
    expect(screen.getByTestId('aggregate-reviews-card')).toBeInTheDocument();
    expect(screen.queryByTestId('reviews-card')).not.toBeInTheDocument();
  });

  it('renders neither card for a non-active subscription (e.g. cancelled)', () => {
    useDashboardDataMock.mockReturnValue({
      data: {
        subscriptionStatus: 'cancelled',
        business: { name: 'Biz', createdAt: '2026-01-01' },
        valueSummary: { totalReviewsHandled: 0, totalTimeSavedMinutes: 0, currentResponseRate: 0, baselineResponseRate: null },
        recentReviews: [],
        reviewVelocity: [],
        ranking: null,
        latestBrief: null,
        settings: {},
        zernioConnection: { status: 'active', queuedReconnectCount: 0, hasUnresolvedIncident: false },
      },
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
    render(<ReviewsContent />);
    expect(screen.queryByTestId('reviews-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aggregate-reviews-card')).not.toBeInTheDocument();
    expect(screen.getByText(/reviews aren't available right now/i)).toBeInTheDocument();
  });
});
