// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseDashboardData } = vi.hoisted(() => ({
  mockUseDashboardData: vi.fn(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => mockUseDashboardData(...args),
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: null, setLocationScope: vi.fn() }),
}));
// TopBar pulls in LocationContext/picker internals; stub it to a title marker.
vi.mock('@/components/dashboard/shell/TopBar', () => ({
  TopBar: ({ title }: { title: string }) => <div data-testid="topbar">{title}</div>,
}));

import { InsightsContent } from '@/components/dashboard/insights/InsightsContent';

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.clearAllMocks());

function setData(data: unknown, extra: Record<string, unknown> = {}) {
  mockUseDashboardData.mockReturnValue({
    data, error: null, loading: false, refresh: vi.fn(), scopeFallback: null, ...extra,
  });
}

describe('InsightsContent', () => {
  it('renders Velocity, Ranking, and Brief for an active single-location owner', () => {
    setData({
      reviewVelocity: [{ weekStart: '2026-05-04', count: 3 }],
      ranking: [{ keyword: 'coffee', snapshots: [{ date: '2026-05-01', position: 2 }] }],
      latestBrief: { text: 'Strong month for five-star reviews.', type: 'monthly', periodLabel: 'May 2026' },
    });
    render(<InsightsContent />);
    expect(screen.getByTestId('topbar')).toHaveTextContent('Insights');
    expect(screen.getByText('Review Velocity')).toBeInTheDocument();
    expect(screen.getByText('Search Ranking')).toBeInTheDocument();
    expect(screen.getByText('Intelligence Brief')).toBeInTheDocument();
  });

  it('does not crash when the active owner has no ranking or brief', () => {
    setData({ reviewVelocity: [], ranking: null, latestBrief: null });
    render(<InsightsContent />);
    expect(screen.getByText('Review Velocity')).toBeInTheDocument();
    expect(screen.queryByText('Search Ranking')).not.toBeInTheDocument();
    expect(screen.queryByText('Intelligence Brief')).not.toBeInTheDocument();
  });

  it('shows a per-location prompt for the aggregate scope (no analytics crash)', () => {
    setData({ scope: 'aggregate', recentReviews: [], valueSummary: {}, locationKpis: [] });
    render(<InsightsContent />);
    expect(screen.getByText(/Insights are shown per location/i)).toBeInTheDocument();
    expect(screen.queryByText('Review Velocity')).not.toBeInTheDocument();
  });

  it('renders the loading state with a polite live region', () => {
    setData(null, { loading: true });
    render(<InsightsContent />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading your insights');
  });

  it('degrades to the pending-payment screen, not a crash', () => {
    setData({ subscriptionStatus: 'pending_payment', businessName: 'Biz', paymentUrl: '/onboarding/pay' });
    render(<InsightsContent />);
    expect(screen.queryByText('Review Velocity')).not.toBeInTheDocument();
  });
});
