// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { ReviewsCard } from '@/components/dashboard/reviews/ReviewsCard';

afterEach(() => vi.unstubAllGlobals());

type CardProps = ComponentProps<typeof ReviewsCard>;

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
    autoPostScheduledAt: null,
    escalation: null,
  },
];

function renderCard(items: CardProps['items'], overrides: Partial<CardProps> = {}) {
  return render(
    <ReviewsCard
      items={items}
      pendingTotal={items.filter((item) => item.responseStatus === 'pending_approval').length}
      total={items.length}
      hasMore={false}
      onLoadMore={() => {}}
      onActionSuccess={() => {}}
      {...overrides}
    />,
  );
}

describe('ReviewsCard', () => {
  it('renders only the pending queue, with no in-card tabs (All Recent dropped)', () => {
    renderCard(REVIEWS);
    expect(screen.getByText('Daniel')).toBeInTheDocument();
    // Posted reviews live on the Reviews → All Reviews tab now, never in the queue.
    expect(screen.queryByText('Sarah')).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /all recent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /needs action/i })).not.toBeInTheDocument();
  });

  it('renders the empty state when no pending reviews, without email framing (UX audit D34)', () => {
    const onlyPosted = [REVIEWS[1]!];
    renderCard(onlyPosted);
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
    expect(screen.getByText(/we'll let you know/i)).toBeInTheDocument();
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });

  it('hides pending review action buttons in read-only mode', () => {
    renderCard(REVIEWS, { readOnly: true });

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
      autoPostScheduledAt: null,
      escalation: { id: 'esc-held', status: 'escalated' as const, severity: 'high' as const },
    },
  ];

  it('shows the single Mark as handled control on a card with an open escalation and NO pending draft', () => {
    renderCard(HELD_ESCALATED);

    expect(screen.getByRole('button', { name: /mark as handled/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /acknowledge|^resolve$/i })).not.toBeInTheDocument();
    // Draft actions stay gated on the draft itself.
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^regenerate$/i })).not.toBeInTheDocument();
  });

  it('POSTs resolve from a draft-less card and refreshes on 200', async () => {
    const onActionSuccess = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, status: 'resolved' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderCard(HELD_ESCALATED, { onActionSuccess });
    fireEvent.click(screen.getByRole('button', { name: /mark as handled/i }));

    await waitFor(() => expect(onActionSuccess).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/dashboard/escalations/esc-held/resolve',
      { method: 'POST' },
    );
  });

  it('renders exactly one escalation control alongside draft actions when a draft exists', () => {
    const withDraft = [
      { ...HELD_ESCALATED[0]!, id: 'r-draft', responseText: 'We are so sorry — please reach out.' },
    ];
    renderCard(withDraft);

    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /mark as handled/i })).toHaveLength(1);
  });

  it('hides escalation actions in read-only mode (routes reject non-writable subscriptions)', () => {
    renderCard(HELD_ESCALATED, { readOnly: true });

    expect(screen.queryByRole('button', { name: /mark as handled/i })).not.toBeInTheDocument();
  });
});
