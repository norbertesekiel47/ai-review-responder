// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AggregateDashboardData } from '@/lib/dashboard/types';

vi.mock('@/components/dashboard/shell/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/contexts/PendingCountContext', () => ({
  useSetPendingCount: () => () => {},
}));
vi.mock('@/components/dashboard/aggregate/LocationKpiStrip', () => ({
  LocationKpiStrip: () => null,
}));
// Markers (not null) so the composition test fails loudly if either aggregate
// chart is re-added to the dashboard after their move to Analytics.
vi.mock('@/components/dashboard/aggregate/AggregateVelocityCard', () => ({
  AggregateVelocityCard: () => <div data-testid="aggregate-velocity" />,
}));
vi.mock('@/components/dashboard/aggregate/AggregateRankingCard', () => ({
  AggregateRankingCard: () => <div data-testid="aggregate-ranking" />,
}));
vi.mock('@/components/dashboard/aggregate/AggregateIntelligenceBriefCard', () => ({
  AggregateIntelligenceBriefCard: () => null,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { AggregateDashboardContent } from '@/components/dashboard/aggregate/AggregateDashboardContent';

const data: AggregateDashboardData = {
  scope: 'aggregate',
  valueSummary: { totalReviewsHandled: 12, totalTimeSavedMinutes: 84, currentResponseRate: 90, baselineResponseRate: null },
  reviewVelocity: [],
  perLocationVelocity: [],
  ranking: null,
  perLocationRanking: [],
  recentReviews: [],
  perLocationBriefs: [],
  locationKpis: [],
  activeLocationCount: 2,
};

describe('AggregateDashboardContent', () => {
  it('renders the action strip linking to the Reviews page and no review feed', () => {
    render(<AggregateDashboardContent data={data} refresh={vi.fn()} />);
    // Caught up (0 pending) -> "View all reviews" link to the Reviews page.
    expect(screen.getByRole('link', { name: /view all reviews/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
    // The combined review feed no longer lives on the dashboard.
    expect(screen.queryByText(/needs action/i)).not.toBeInTheDocument();
  });

  it('drops the aggregate velocity/ranking charts (relocated to Analytics)', () => {
    const populated: AggregateDashboardData = {
      ...data,
      valueSummary: { ...data.valueSummary, totalReviewsHandled: 12 },
    };
    render(<AggregateDashboardContent data={populated} refresh={vi.fn()} />);
    expect(screen.queryByTestId('aggregate-velocity')).not.toBeInTheDocument();
    expect(screen.queryByTestId('aggregate-ranking')).not.toBeInTheDocument();
  });
});
