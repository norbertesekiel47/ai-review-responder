// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WeeklyRecapCard } from '@/components/dashboard/kpi/WeeklyRecapCard';
import type { ReputationSummary } from '@/lib/dashboard/types';

function series(counts: Array<[count: number, star: number | null]>): ReputationSummary['trend'] {
  return counts.map(([reviewCount, starEquivalent], index) => ({
    weekStart: new Date(Date.UTC(2026, 6, 6 + index * 7)).toISOString().slice(0, 10),
    reviewCount,
    starEquivalent,
  }));
}

const LIVE = series([
  [0, null], [2, 2.5], [2, 5], [2, 5],
  [0, null], [0, null], [0, null], [1, 5],
]);

describe('WeeklyRecapCard', () => {
  it('renders nothing without a series — the hero owns that message', () => {
    const { container } = render(<WeeklyRecapCard trend={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('leads with the interpretation, then the numbers', () => {
    render(<WeeklyRecapCard trend={LIVE} />);

    expect(screen.getByText('One new review this week.')).toBeInTheDocument();
    expect(screen.getByText('new this week')).toBeInTheDocument();
    // The second stat is a COUNT, sharing the unit of the bars beside it — the
    // hero above already owns the screen's one "average rating" figure.
    expect(screen.getByText('in the last 8 weeks')).toBeInTheDocument();
    expect(screen.queryByText(/star-equivalent/i)).not.toBeInTheDocument();
  });

  it('answers "why does this week look like that" in place', () => {
    render(<WeeklyRecapCard trend={LIVE} />);

    expect(screen.getByText('The 3 weeks before this one were quiet.')).toBeInTheDocument();
  });

  it('gives the weekly bars a text equivalent, per the chart rule', () => {
    render(<WeeklyRecapCard trend={LIVE} />);

    expect(
      screen.getByRole('img', { name: 'Reviews per week over the last 8 weeks, 7 in total' }),
    ).toBeInTheDocument();
  });

  it('counts the whole run, not just the covered week', () => {
    render(<WeeklyRecapCard trend={series([[2, 4], [0, null]])} />);

    expect(screen.getByText('No new reviews yet this week.')).toBeInTheDocument();
    expect(screen.getByText('in the last 2 weeks')).toBeInTheDocument();
  });

  it('renders the quiet run as content, not as an absence', () => {
    render(<WeeklyRecapCard trend={series([[0, null], [0, null]])} />);

    expect(screen.getByText('No reviews in the last 2 weeks.')).toBeInTheDocument();
    expect(screen.getByText('New reviews appear here as they arrive.')).toBeInTheDocument();
  });

  it('stands alone when the Insights agent has sent nothing', () => {
    render(<WeeklyRecapCard trend={LIVE} />);

    expect(screen.queryByText(/from your insights agent/i)).not.toBeInTheDocument();
    // The card is still complete without it.
    expect(screen.getByText('One new review this week.')).toBeInTheDocument();
  });

  it('folds in the brief when one exists, capped at three bullets', () => {
    render(
      <WeeklyRecapCard
        trend={LIVE}
        brief={{
          type: 'weekly',
          periodLabel: 'Week of 2026-08-24',
          text: '- Wait times came up twice\n- Parking praised four times\n- One request for late hours\n- A fourth point',
        }}
      />,
    );

    expect(screen.getByText(/from your insights agent/i)).toBeInTheDocument();
    expect(screen.getByText('Wait times came up twice')).toBeInTheDocument();
    expect(screen.getByText('One request for late hours')).toBeInTheDocument();
    expect(screen.queryByText('A fourth point')).not.toBeInTheDocument();
  });

  it('marks the running week apart from the closed ones', () => {
    const { container } = render(<WeeklyRecapCard trend={LIVE} />);

    expect(container.querySelectorAll('.recap-bar')).toHaveLength(8);
    expect(container.querySelectorAll('.recap-bar--current')).toHaveLength(1);
  });
});

describe('WeeklyRecapCard info tip (#1086)', () => {
  // The series groups on DATE_TRUNC('week', LEAST(review_date, detected_at))
  // — the review-time anchor of ADR 0019. An owner comparing this card against
  // Google cannot see that from a label.
  it('every covered surface names what its number means', () => {
    render(<WeeklyRecapCard trend={LIVE} />);

    const trigger = screen.getByRole('button', { name: 'What Your week means' });
    const panel = document.getElementById(trigger.getAttribute('aria-controls') as string);

    expect(panel).toHaveTextContent('the week it was written');
    expect(panel).toHaveTextContent('not the week RepWorth found it');
  });

  it('keeps the tip out of the heading, so the card is still named "Your week"', () => {
    const { container } = render(<WeeklyRecapCard trend={LIVE} />);

    expect(screen.getByRole('region', { name: 'Your week' })).toBeInTheDocument();
    expect(container.querySelector('#recap-heading .info-tip')).toBeNull();
  });
});
