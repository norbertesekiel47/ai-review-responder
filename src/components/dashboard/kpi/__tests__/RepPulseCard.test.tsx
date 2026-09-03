// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RepPulseCard } from '@/components/dashboard/kpi/RepPulseCard';
import type { ReputationSummary } from '@/lib/dashboard/types';

function summary(overrides: Partial<{
  star: number | null;
  rate: number | null;
  starDelta: number | null;
  isRamping: boolean;
}> = {}): ReputationSummary {
  return {
    averageStar: {
      current: overrides.star === undefined ? 4.6 : overrides.star,
      delta: overrides.starDelta === undefined ? 0.2 : overrides.starDelta,
      priorSampleSize: 9,
    },
    responseRate: {
      current: overrides.rate === undefined ? 92 : overrides.rate,
      delta: null,
      priorSampleSize: 9,
    },
    timeSavedMinutes: { current: 60, delta: null, priorSampleSize: 9 },
    pendingApprovalCount: 0,
    trend: [],
    isRamping: overrides.isRamping ?? false,
  };
}

describe('RepPulseCard — scored', () => {
  it('answers "what moved it" in place, instead of linking away for it', () => {
    render(<RepPulseCard summary={summary()} />);

    expect(screen.getByText('What moved it')).toBeInTheDocument();
    expect(screen.getByText('Rating')).toBeInTheDocument();
    expect(screen.getByText('4.6 / 5')).toBeInTheDocument();
    expect(screen.getByText('Replies')).toBeInTheDocument();
    expect(screen.getByText('92%')).toBeInTheDocument();
  });

  it('shows contributions that add up to the score on screen', () => {
    const { container } = render(<RepPulseCard summary={summary()} />);

    const score = Number(container.querySelector('.pulse-num b')!.textContent);
    const points = Array.from(container.querySelectorAll('.pulse-part-points')).map((node) =>
      // The node reads "64/70"; the part before the slash is the contribution.
      Number(node.textContent!.split('/')[0]),
    );

    expect(points.reduce((total, part) => total + part, 0)).toBe(score);
  });

  it('keeps the trend link, but no longer as the explanation', () => {
    render(<RepPulseCard summary={summary()} />);

    const link = screen.getByRole('link', { name: /see the full trend/i });
    expect(link).toHaveAttribute('href', '/dashboard/analytics');
    expect(screen.queryByRole('link', { name: /what moved it/i })).not.toBeInTheDocument();
  });

  it('does not claim a 30-point input when the reply rate is unknown', () => {
    const { container } = render(<RepPulseCard summary={summary({ rate: null })} />);

    const parts = container.querySelectorAll('.pulse-part');
    expect(parts).toHaveLength(1);
    expect(within(parts[0] as HTMLElement).getByText(/\/100/)).toBeInTheDocument();
  });
});

describe('RepPulseCard — ramping', () => {
  it('still shows no score, and invents none', () => {
    render(<RepPulseCard summary={summary({ isRamping: true })} />);

    expect(screen.getByRole('status')).toHaveTextContent('—');
    expect(
      screen.getByText('Your Rep Pulse appears after your first weeks of reviews.'),
    ).toBeInTheDocument();
  });

  it('turns the bare dash into content by naming what will set the score', () => {
    render(<RepPulseCard summary={summary({ isRamping: true })} />);

    expect(screen.getByText('What will set it')).toBeInTheDocument();
    expect(screen.getByText('Your average rating')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('How often you reply')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
  });

  it('withholds the VALUES, so the score cannot be reconstructed', () => {
    const { container } = render(<RepPulseCard summary={summary({ isRamping: true })} />);

    // The two inputs are named, never measured: no "4.6 / 5", no "92%", no
    // points. Showing the arithmetic would leak the number the ramping rule
    // exists to withhold.
    expect(container.textContent).not.toContain('4.6');
    expect(container.textContent).not.toContain('92');
    expect(container.querySelector('.pulse-part')).toBeNull();
    expect(screen.queryByText('What moved it')).not.toBeInTheDocument();
  });
});

describe('RepPulseCard — info tip (#1086)', () => {
  const TIP_NAME = 'What Rep Pulse means';

  // "What moved it" and "What will set it" both explain the COMPOSITION. A
  // coined name and a Beta chip never say what the number IS.
  it('names what the coined score is, in the scored state', () => {
    render(<RepPulseCard summary={summary()} />);

    const tip = screen.getByRole('button', { name: TIP_NAME });
    const panel = document.getElementById(tip.getAttribute('aria-controls') as string);

    expect(panel).toHaveTextContent('A score out of 100');
    expect(panel).toHaveTextContent('70');
    expect(panel).toHaveTextContent('30');
  });

  it('names it in the ramping state too, where there is no score to read', () => {
    render(<RepPulseCard summary={summary({ isRamping: true })} />);

    expect(screen.getByRole('button', { name: TIP_NAME })).toBeInTheDocument();
  });

  // The section is `aria-labelledby="pulse-heading"`. A trigger inside the
  // heading would become part of the card's accessible name.
  it('sits beside the heading, so the card is still named "Rep Pulse"', () => {
    const { container } = render(<RepPulseCard summary={summary()} />);

    expect(screen.getByRole('region', { name: 'Rep Pulse' })).toBeInTheDocument();
    expect(container.querySelector('#pulse-heading .info-tip')).toBeNull();
    expect(container.querySelector('.pulse-head .info-tip')).not.toBeNull();
  });

  // Intake invariant: a screen reader only announces changes to a region that
  // already existed, so the tip must not displace one.
  it('does not move the ramping card live region in the tree', () => {
    const { container } = render(<RepPulseCard summary={summary({ isRamping: true })} />);

    const head = container.querySelector('.pulse-head');
    const status = container.querySelector('[role="status"]');

    expect(status).toHaveClass('pulse-empty');
    expect(head?.nextElementSibling).toBe(status);
  });
});
