// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';

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
  },
  {
    id: 'r2',
    reviewerName: 'Sarah',
    starRating: 5,
    reviewText: 'Lovely spot.',
    reviewDate: '2026-04-30T09:00:00Z',
    status: 'posted',
    responseText: 'Thank you Sarah!',
    responseStatus: 'posted' as string | null,
  },
];

describe('ReviewsCard', () => {
  it('shows only pending reviews under Needs Action and toggles to all', async () => {
    const user = userEvent.setup();
    render(<ReviewsCard recentReviews={REVIEWS} onActionSuccess={() => {}} />);
    expect(screen.getByText('Daniel')).toBeInTheDocument();
    expect(screen.queryByText('Sarah')).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /all recent/i }));
    expect(screen.getByText('Sarah')).toBeInTheDocument();
  });

  it('renders the empty state when no pending reviews', () => {
    const onlyPosted = [REVIEWS[1]!];
    render(<ReviewsCard recentReviews={onlyPosted} onActionSuccess={() => {}} />);
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
  });

  it('respects initialTab="all"', () => {
    render(<ReviewsCard recentReviews={REVIEWS} onActionSuccess={() => {}} initialTab="all" />);
    expect(screen.getByText('Sarah')).toBeInTheDocument();
  });

  it('hides pending review action buttons in read-only mode', () => {
    render(<ReviewsCard recentReviews={REVIEWS} onActionSuccess={() => {}} readOnly />);

    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing to approve/i)).toBeInTheDocument();
  });
});
