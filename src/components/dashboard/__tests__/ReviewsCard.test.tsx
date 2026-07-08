// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';

afterEach(() => vi.unstubAllGlobals());

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
    escalation: null,
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
    approvalMethod: 'auto_policy' as const,
    escalation: null,
  },
];

describe('ReviewsCard', () => {
  it('renders only the pending queue, with no in-card tabs (All Recent dropped)', () => {
    render(<ReviewsCard recentReviews={REVIEWS} onActionSuccess={() => {}} />);
    expect(screen.getByText('Daniel')).toBeInTheDocument();
    // Posted reviews live on the Reviews → History tab now, never in the queue.
    expect(screen.queryByText('Sarah')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /all recent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /needs action/i })).not.toBeInTheDocument();
  });

  it('renders the empty state when no pending reviews', () => {
    const onlyPosted = [REVIEWS[1]!];
    render(<ReviewsCard recentReviews={onlyPosted} onActionSuccess={() => {}} />);
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
  });

  it('hides pending review action buttons in read-only mode', () => {
    render(<ReviewsCard recentReviews={REVIEWS} onActionSuccess={() => {}} readOnly />);

    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/update billing to approve/i)).toBeInTheDocument();
  });
});

describe('ReviewsCard escalation actions independent of draft state (WS3)', () => {
  // Moderation-HELD lane: the flagged-response NOT EXISTS nulls responseText,
  // so there is no draft block — the escalation must still be actionable.
  const HELD_ESCALATED = [
    {
      id: 'r-held',
      reviewerName: 'Mara',
      starRating: 1,
      reviewText: 'The manager screamed at us.',
      reviewDate: '2026-05-01T09:00:00Z',
      status: 'pending_approval',
      responseText: null,
      responseStatus: 'pending_approval' as string | null,
      approvalMethod: null,
      escalation: { id: 'esc-held', status: 'escalated' as const, severity: 'high' as const },
    },
  ];

  it('shows Acknowledge/Resolve on a card with an open escalation and NO pending draft', () => {
    render(<ReviewsCard recentReviews={HELD_ESCALATED} onActionSuccess={() => {}} />);

    expect(screen.getByRole('button', { name: /acknowledge/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resolve/i })).toBeInTheDocument();
    // Draft actions stay gated on the draft itself.
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).not.toBeInTheDocument();
  });

  it('POSTs acknowledge from a draft-less card and refreshes on 200', async () => {
    const onActionSuccess = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, status: 'acknowledged' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ReviewsCard recentReviews={HELD_ESCALATED} onActionSuccess={onActionSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));

    await waitFor(() => expect(onActionSuccess).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/escalations/esc-held/acknowledge',
      { method: 'POST' },
    );
  });

  it('renders exactly one escalation button set alongside draft actions when a draft exists', () => {
    const withDraft = [
      { ...HELD_ESCALATED[0]!, id: 'r-draft', responseText: 'We are so sorry — please reach out.' },
    ];
    render(<ReviewsCard recentReviews={withDraft} onActionSuccess={() => {}} />);

    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /acknowledge/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /resolve/i })).toHaveLength(1);
  });

  it('hides escalation actions in read-only mode (routes reject non-writable subscriptions)', () => {
    render(<ReviewsCard recentReviews={HELD_ESCALATED} onActionSuccess={() => {}} readOnly />);

    expect(screen.queryByRole('button', { name: /acknowledge/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument();
  });
});
