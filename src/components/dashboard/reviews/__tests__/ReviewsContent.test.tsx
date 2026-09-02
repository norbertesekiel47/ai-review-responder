// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { useDashboardDataMock, usePendingApprovalsMock } = vi.hoisted(() => ({
  useDashboardDataMock: vi.fn(),
  usePendingApprovalsMock: vi.fn(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: () => useDashboardDataMock(),
}));
vi.mock('@/components/dashboard/reviews/usePendingApprovals', () => ({
  usePendingApprovals: () => usePendingApprovalsMock(),
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

const loadedQueue = {
  items: [],
  total: 0,
  pendingTotal: 0,
  loading: false,
  error: null,
  hasMore: false,
  loadingMore: false,
  loadMore: vi.fn(),
  refetch: vi.fn(),
};

function dashboard(overrides: Record<string, unknown> = {}) {
  return { data: baseActive, error: null, loading: false, refreshing: false, refresh: vi.fn(), ...overrides };
}

describe('ReviewsContent', () => {
  beforeEach(() => {
    usePendingApprovalsMock.mockReturnValue(loadedQueue);
  });

  it('renders the per-location ReviewsCard for active per-location data', () => {
    useDashboardDataMock.mockReturnValue(dashboard());
    render(<ReviewsContent />);
    expect(screen.getByTestId('reviews-card')).toBeInTheDocument();
    expect(screen.queryByTestId('aggregate-reviews-card')).not.toBeInTheDocument();
  });

  it('renders the AggregateReviewsCard for aggregate data', () => {
    useDashboardDataMock.mockReturnValue(dashboard({
      data: { scope: 'aggregate', recentReviews: [], isReadOnly: false, locationKpis: [] },
    }));
    render(<ReviewsContent />);
    expect(screen.getByTestId('aggregate-reviews-card')).toBeInTheDocument();
    expect(screen.queryByTestId('reviews-card')).not.toBeInTheDocument();
  });

  it('renders neither card for a non-active subscription (e.g. cancelled)', () => {
    useDashboardDataMock.mockReturnValue(dashboard({
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
    }));
    render(<ReviewsContent />);
    expect(screen.queryByTestId('reviews-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aggregate-reviews-card')).not.toBeInTheDocument();
    expect(screen.getByText(/reviews aren't available right now/i)).toBeInTheDocument();
  });

  // #678: the second tab is `All Reviews` and renders unconditionally — the
  // flag that used to hide it (PAST_REPLIES_VIEW_ENABLED) is retired, so the
  // hidden-tab case no longer exists.
  it('renders the routed All Reviews tab under its TopBar', () => {
    useDashboardDataMock.mockReturnValue(dashboard());
    render(<ReviewsContent />);
    expect(screen.getByRole('link', { name: /needs action/i })).toHaveAttribute('href', '/dashboard/reviews');
    expect(screen.getByRole('link', { name: /all reviews/i })).toHaveAttribute('href', '/dashboard/reviews/history');
  });

  // UX audit D3: a failed first fetch shows the error card, not an endless skeleton.
  it('shows the error card when the first fetch fails and nothing is on screen', () => {
    useDashboardDataMock.mockReturnValue(dashboard({ data: null, error: 'Request failed (500)' }));
    render(<ReviewsContent />);
    expect(screen.getByRole('heading', { name: 'Unable to load reviews' })).toBeInTheDocument();
    expect(screen.queryByText('Loading your reviews…')).not.toBeInTheDocument();
  });

  it('shows the error card when the queue read fails', () => {
    useDashboardDataMock.mockReturnValue(dashboard());
    usePendingApprovalsMock.mockReturnValue({ ...loadedQueue, items: null, error: 'No active location available' });
    render(<ReviewsContent />);
    expect(screen.getByText('No active location available', { selector: 'p' })).toBeInTheDocument();
  });

  it('shows the skeleton only while no data has arrived yet', () => {
    useDashboardDataMock.mockReturnValue(dashboard({ data: null, loading: true }));
    render(<ReviewsContent />);
    expect(screen.getByText('Loading your reviews…')).toBeInTheDocument();
  });

  // UX audit D1: stale data stays on screen through a background refresh, even a failed one.
  it('keeps the queue on screen during a background refresh and after a refresh error', () => {
    useDashboardDataMock.mockReturnValue(dashboard({ refreshing: true, error: 'Upstream timeout' }));
    render(<ReviewsContent />);
    expect(screen.getByTestId('reviews-card')).toBeInTheDocument();
    expect(screen.queryByText('Loading your reviews…')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Unable to load reviews' })).not.toBeInTheDocument();
  });
});
