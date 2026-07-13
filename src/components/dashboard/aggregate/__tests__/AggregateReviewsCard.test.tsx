// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AggregateReviewsCard } from '@/components/dashboard/aggregate/AggregateReviewsCard';

const REVIEWS = [
  {
    id: 'r1',
    reviewerName: 'Daniel',
    starRating: 5,
    reviewText: 'Great coffee.',
    reviewDate: '2026-05-01T09:00:00Z',
    status: 'pending_approval',
    responseText: 'Thanks Daniel!',
    responseStatus: 'pending_approval' as string | null,
    approvalMethod: null,
    autoPostScheduledAt: null,
    escalation: null,
    locationId: 'loc-1',
    locationDisplayName: 'Downtown',
  },
  {
    id: 'r2',
    reviewerName: 'Sarah',
    starRating: 5,
    reviewText: 'Great.',
    reviewDate: '2026-04-30T09:00:00Z',
    status: 'posted',
    responseText: 'Thanks Sarah!',
    responseStatus: 'posted' as string | null,
    approvalMethod: 'auto_policy' as const,
    autoPostScheduledAt: null,
    escalation: null,
    locationId: 'loc-2',
    locationDisplayName: 'Uptown',
  },
];

describe('AggregateReviewsCard', () => {
  it('renders only the pending queue, with no in-card tabs (All Recent dropped)', () => {
    render(<AggregateReviewsCard recentReviews={REVIEWS} onActionSuccess={() => {}} />);
    expect(screen.getByText('Daniel')).toBeInTheDocument();
    // Posted reviews live on the Reviews → History tab now, never in the queue.
    expect(screen.queryByText('Sarah')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /all recent/i })).not.toBeInTheDocument();
  });

  it('hides pending review action buttons in read-only mode', () => {
    render(<AggregateReviewsCard recentReviews={REVIEWS} onActionSuccess={() => {}} readOnly />);

    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing to approve/i)).toBeInTheDocument();
  });
});
