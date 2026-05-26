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
    locationId: 'loc-1',
    locationDisplayName: 'Downtown',
  },
];

describe('AggregateReviewsCard', () => {
  it('hides pending review action buttons in read-only mode', () => {
    render(<AggregateReviewsCard recentReviews={REVIEWS} onActionSuccess={() => {}} readOnly />);

    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing to approve/i)).toBeInTheDocument();
  });
});
