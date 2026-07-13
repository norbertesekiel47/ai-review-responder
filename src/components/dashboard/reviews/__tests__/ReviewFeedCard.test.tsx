// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import {
  formatScheduledChipTime,
  ReviewFeedCard,
} from '@/components/dashboard/reviews/ReviewFeedCard';

type ReviewFixture = ComponentProps<typeof ReviewFeedCard>['recentReviews'][number];

const BASE_REVIEW = {
  id: 'review-1',
  reviewerName: 'Daniel',
  starRating: 5,
  reviewText: 'Great coffee.',
  reviewDate: '2026-07-13T09:00:00.000Z',
  status: 'pending_approval',
  responseText: 'Thanks Daniel!',
  responseStatus: 'pending_approval' as string | null,
  approvalMethod: null,
  autoPostScheduledAt: null,
  escalation: null,
} satisfies ReviewFixture;

afterEach(() => vi.useRealTimers());

function renderFeed(reviews: readonly ReviewFixture[] = [BASE_REVIEW]) {
  return render(
    <ReviewFeedCard
      recentReviews={reviews}
      onActionSuccess={() => {}}
      emptyText="Nothing waiting."
    />,
  );
}

function revealClock() {
  act(() => vi.advanceTimersByTime(0));
}

/**
 * Expected chip time computed through the exported helper (same Intl path the
 * component uses), so assertions hold in any machine timezone. Call only after
 * vi.setSystemTime so Date.now() matches the component's clock.
 */
function expectedChipTime(deadlineIso: string): string {
  return formatScheduledChipTime(new Date(deadlineIso).getTime(), Date.now());
}

describe('ReviewFeedCard persona surfaces', () => {
  it('attributes a visible manual draft to Reply and links its card to the timeline', () => {
    renderFeed();

    expect(screen.getByText('Reply')).toBeInTheDocument();
    expect(screen.queryByText('Reply · Auto')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View agent timeline for Daniel' }))
      .toHaveAttribute('href', '/dashboard/reviews/review-1/timeline');
  });

  it('uses the auto variant only for an auto-policy response', () => {
    renderFeed([{ ...BASE_REVIEW, approvalMethod: 'auto_policy' as const }]);

    expect(screen.getByText('Reply · Auto')).toBeInTheDocument();
    expect(screen.queryByText('Reply')).not.toBeInTheDocument();
  });

  it('attributes an open escalation to Guardian alongside Reply, never Insights', () => {
    renderFeed([{
      ...BASE_REVIEW,
      escalation: { id: 'escalation-1', status: 'escalated' as const, severity: 'high' as const },
    }]);

    expect(screen.getByText('Reply')).toBeInTheDocument();
    expect(screen.getByText('Guardian')).toBeInTheDocument();
    expect(screen.queryByText(/Insights/)).not.toBeInTheDocument();
  });

  it('keeps a future approved auto-post visible and links its scheduled chip to the timeline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T17:00:00.000Z'));
    renderFeed([{
      ...BASE_REVIEW,
      status: 'approved',
      responseStatus: 'approved',
      approvalMethod: 'auto_policy' as const,
      autoPostScheduledAt: '2026-07-13T18:05:00.000Z',
    }]);
    revealClock();

    expect(screen.getByText('Daniel')).toBeInTheDocument();
    expect(screen.getByText('0 awaiting your approval')).toBeInTheDocument();
    expect(screen.queryByText('All caught up!')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Scheduled — posts at ${expectedChipTime('2026-07-13T18:05:00.000Z')}` }))
      .toHaveAttribute('href', '/dashboard/reviews/review-1/timeline');
  });

  it('shows a neutral status until the clock confirms a future scheduled card', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T17:00:00.000Z'));
    renderFeed([{
      ...BASE_REVIEW,
      status: 'approved',
      responseStatus: 'approved',
      approvalMethod: 'auto_policy',
      autoPostScheduledAt: '2026-07-13T18:05:00.000Z',
    }]);

    expect(screen.getByRole('status')).toHaveTextContent('Checking scheduled posts');
    expect(screen.queryByText('All caught up!')).not.toBeInTheDocument();
    expect(screen.queryByText('Daniel')).not.toBeInTheDocument();

    revealClock();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Daniel')).toBeInTheDocument();
  });

  it('resolves a neutral scheduled-candidate state to empty when the deadline is expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T17:00:00.000Z'));
    renderFeed([{
      ...BASE_REVIEW,
      status: 'approved',
      responseStatus: 'approved',
      approvalMethod: 'auto_policy',
      autoPostScheduledAt: '2026-07-13T16:59:59.000Z',
    }]);

    expect(screen.getByRole('status')).toHaveTextContent('Checking scheduled posts');
    expect(screen.queryByText('Daniel')).not.toBeInTheDocument();

    revealClock();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('Daniel')).not.toBeInTheDocument();
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
  });

  it('uses the review status when no response status is projected', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T17:00:00.000Z'));
    renderFeed([{
      ...BASE_REVIEW,
      status: 'approved',
      responseStatus: null,
      approvalMethod: 'auto_policy',
      autoPostScheduledAt: '2026-07-13T18:05:00.000Z',
    }]);
    revealClock();

    expect(screen.getByRole('link', { name: `Scheduled — posts at ${expectedChipTime('2026-07-13T18:05:00.000Z')}` }))
      .toBeInTheDocument();
  });

  it('removes scheduled cards as each future deadline passes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T17:00:00.000Z'));
    renderFeed([
      {
        ...BASE_REVIEW,
        status: 'approved',
        responseStatus: 'approved',
        approvalMethod: 'auto_policy',
        autoPostScheduledAt: '2026-07-13T17:01:00.000Z',
      },
      {
        ...BASE_REVIEW,
        id: 'review-2',
        reviewerName: 'Casey',
        status: 'approved',
        responseStatus: 'approved',
        approvalMethod: 'auto_policy',
        autoPostScheduledAt: '2026-07-13T17:02:00.000Z',
      },
    ]);
    revealClock();

    expect(screen.getByRole('link', { name: `Scheduled — posts at ${expectedChipTime('2026-07-13T17:01:00.000Z')}` })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `Scheduled — posts at ${expectedChipTime('2026-07-13T17:02:00.000Z')}` })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(60_001));
    expect(screen.queryByText('Daniel')).not.toBeInTheDocument();
    expect(screen.getByText('Casey')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText('Casey')).not.toBeInTheDocument();
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
  });

  it.each([
    {
      caseName: 'past deadline',
      review: { responseStatus: 'approved', status: 'approved', approvalMethod: 'auto_policy' as const, autoPostScheduledAt: '2026-07-13T16:59:59.000Z' },
      cardRemainsVisible: false,
    },
    {
      caseName: 'invalid deadline',
      review: { responseStatus: 'approved', status: 'approved', approvalMethod: 'auto_policy' as const, autoPostScheduledAt: 'not-a-date' },
      cardRemainsVisible: false,
    },
    {
      caseName: 'owner approval',
      review: { responseStatus: 'approved', status: 'approved', approvalMethod: 'owner' as const, autoPostScheduledAt: '2026-07-13T18:05:00.000Z' },
      cardRemainsVisible: false,
    },
    {
      caseName: 'pending response',
      review: { responseStatus: 'pending_approval', status: 'pending_approval', approvalMethod: 'auto_policy' as const, autoPostScheduledAt: '2026-07-13T18:05:00.000Z' },
      cardRemainsVisible: true,
    },
    {
      caseName: 'posted response over an approved review status',
      review: { responseStatus: 'posted', status: 'approved', approvalMethod: 'auto_policy' as const, autoPostScheduledAt: '2026-07-13T18:05:00.000Z' },
      cardRemainsVisible: false,
    },
  ])('does not show a scheduled chip for $caseName', ({ review, cardRemainsVisible }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T17:00:00.000Z'));
    renderFeed([{ ...BASE_REVIEW, ...review }]);
    revealClock();

    expect(screen.queryByRole('link', { name: /Scheduled — posts at/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Daniel') !== null).toBe(cardRemainsVisible);
  });

  it('keeps a pending card free of persona ghosts when it has no response or escalation', () => {
    renderFeed([{ ...BASE_REVIEW, responseText: null }]);

    expect(screen.queryByText(/^Reply/)).not.toBeInTheDocument();
    expect(screen.queryByText('Guardian')).not.toBeInTheDocument();
    expect(screen.queryByText(/Insights/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View agent timeline for Daniel' }))
      .toBeInTheDocument();
  });

  it('keeps posted, non-scheduled reviews in History instead of the action surface', () => {
    renderFeed([{
      ...BASE_REVIEW,
      status: 'posted',
      responseStatus: 'posted',
      approvalMethod: 'auto_policy',
    }]);

    expect(screen.queryByText('Daniel')).not.toBeInTheDocument();
    expect(screen.getByText('All caught up!')).toBeInTheDocument();
  });
});

describe('formatScheduledChipTime', () => {
  const LOS_ANGELES = 'America/Los_Angeles';

  it('renders hour and minute in the given zone when the deadline is today there', () => {
    const now = new Date('2026-07-13T17:00:00.000Z').getTime(); // 10:00 AM in LA
    const deadline = new Date('2026-07-13T20:05:00.000Z').getTime(); // 1:05 PM in LA

    expect(formatScheduledChipTime(deadline, now, LOS_ANGELES)).toBe('1:05 PM');
  });

  it('includes month and day when the deadline is not today in the given zone', () => {
    const now = new Date('2026-07-13T17:00:00.000Z').getTime(); // Jul 13 in LA
    const deadline = new Date('2026-07-14T18:05:00.000Z').getTime(); // Jul 14, 11:05 AM in LA

    expect(formatScheduledChipTime(deadline, now, LOS_ANGELES)).toBe('Jul 14, 11:05 AM');
  });

  it('judges "today" in the viewer zone, not UTC', () => {
    const now = new Date('2026-07-13T17:00:00.000Z').getTime(); // Jul 13, 10:00 AM in LA
    const deadline = new Date('2026-07-14T02:00:00.000Z').getTime(); // still Jul 13, 7:00 PM in LA

    expect(formatScheduledChipTime(deadline, now, LOS_ANGELES)).toBe('7:00 PM');
  });

  it('defaults to the runtime local zone when no zone is given', () => {
    const now = new Date('2026-07-13T17:00:00.000Z').getTime();
    const deadline = new Date('2026-07-13T18:05:00.000Z').getTime();
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(formatScheduledChipTime(deadline, now))
      .toBe(formatScheduledChipTime(deadline, now, localZone));
  });
});
