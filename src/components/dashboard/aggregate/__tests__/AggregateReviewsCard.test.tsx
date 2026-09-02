// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { AggregateReviewsCard } from '@/components/dashboard/aggregate/AggregateReviewsCard';

type CardProps = ComponentProps<typeof AggregateReviewsCard>;

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

function renderCard(overrides: Partial<CardProps> = {}) {
  return render(
    <AggregateReviewsCard
      items={REVIEWS}
      pendingTotal={1}
      total={REVIEWS.length}
      hasMore={false}
      onLoadMore={() => {}}
      onActionSuccess={() => {}}
      {...overrides}
    />,
  );
}

describe('AggregateReviewsCard', () => {
  it('renders only the pending queue with its location chip, and no in-card tabs', () => {
    renderCard();
    expect(screen.getByText('Daniel')).toBeInTheDocument();
    expect(screen.getByText('Downtown')).toBeInTheDocument();
    // Posted reviews live on the Reviews → All Reviews tab now, never in the queue.
    expect(screen.queryByText('Sarah')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /all recent/i })).not.toBeInTheDocument();
  });

  it('hides pending review action buttons in read-only mode', () => {
    renderCard({ readOnly: true });

    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing to approve/i)).toBeInTheDocument();
  });

  it('says "we\'ll let you know" in the empty state — no email framing (UX audit D34)', () => {
    renderCard({ items: [REVIEWS[1]!], pendingTotal: 0, total: 1 });
    expect(screen.getByText(/we'll let you know/i)).toBeInTheDocument();
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });
});
