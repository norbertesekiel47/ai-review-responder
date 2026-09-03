// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReputationHeroBand } from '@/components/dashboard/kpi/ReputationHeroBand';
import { RESPONSE_RATE_PERIOD_CONTEXT } from '@/components/dashboard/kpi/response-rate-copy';
import { MINUTES_SAVED_PER_RESPONSE } from '@/lib/dashboard/constants';
import type { ReputationSummary } from '@/lib/dashboard/types';

const baseSummary: ReputationSummary = {
  averageStar: { current: 4.8, delta: 0.2, priorSampleSize: 30 },
  responseRate: { current: 94, delta: 6, priorSampleSize: 40 },
  timeSavedMinutes: { current: 1080, delta: 540, priorSampleSize: 9 }, // 18h, +9h
  pendingApprovalCount: 3,
  trend: [{ weekStart: '2026-05-01', starEquivalent: 4.7, reviewCount: 5 }],
  isRamping: false,
};

describe('ReputationHeroBand', () => {
  it('explains that response rate includes imported history', () => {
    render(
      <ReputationHeroBand
        summary={baseSummary}
        lifetimeReviewsHandled={1284}
        lifetimeTimeSavedMinutes={3120}
        connected
      />,
    );

    const context = screen.getByText(
      'Response rate is based on reviews added to RepWorth in this period, including imported history.',
    );
    expect(context).toBeInTheDocument();
    expect(context).toHaveClass('rep-period-context');
    expect(context.closest('.rep-stat')).toBeNull();
  });

  it('renders the three reputation stats with values and deltas', () => {
    render(
      <ReputationHeroBand
        summary={baseSummary}
        lifetimeReviewsHandled={1284}
        lifetimeTimeSavedMinutes={3120}
        connected
      />,
    );
    expect(screen.getByText('Average rating')).toBeInTheDocument();
    expect(screen.getByText('4.8')).toBeInTheDocument();
    expect(screen.getByText('Response rate')).toBeInTheDocument();
    expect(screen.getByText('Time saved')).toBeInTheDocument();
    // Deltas (split by an inline arrow svg — match on substring text).
    expect(screen.getByText(/rating points/)).toBeInTheDocument();
    expect(screen.getByText(/hrs vs prior 30 days/)).toBeInTheDocument();
    // Lifetime reassurance foot.
    expect(screen.getByText(/replies handled for you since joining/)).toBeInTheDocument();
    expect(screen.getByText(/Google connected/)).toBeInTheDocument();
  });

  it('renders compact baseline copy and no lifetime foot while ramping', () => {
    render(
      <ReputationHeroBand
        summary={{ ...baseSummary, isRamping: true }}
        lifetimeReviewsHandled={4}
        lifetimeTimeSavedMinutes={28}
        connected
      />,
    );
    expect(screen.getByText(/Still building your baseline/)).toBeInTheDocument();
    expect(screen.getByText(/including imported history/)).toBeInTheDocument();
    expect(screen.queryByText(/replies handled for you since joining/)).not.toBeInTheDocument();
  });

  it('shows an em-dash placeholder when a current value is unavailable', () => {
    render(
      <ReputationHeroBand
        summary={{
          ...baseSummary,
          averageStar: { current: null, delta: null, priorSampleSize: 0 },
        }}
        lifetimeReviewsHandled={1284}
        lifetimeTimeSavedMinutes={3120}
        connected={false}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/Google connected/)).not.toBeInTheDocument();
  });
});

describe('ReputationHeroBand footer grammar', () => {
  it('says "1 reply" and "1 hour", not "1 replies" and "1 hours"', () => {
    render(
      <ReputationHeroBand
        summary={{
          averageStar: { current: 4.6, delta: 0.2, priorSampleSize: 9 },
          responseRate: { current: 92, delta: null, priorSampleSize: 9 },
          timeSavedMinutes: { current: 60, delta: null, priorSampleSize: 9 },
          pendingApprovalCount: 0,
          trend: [],
          isRamping: false,
        }}
        lifetimeReviewsHandled={1}
        lifetimeTimeSavedMinutes={60}
        connected
      />,
    );

    expect(screen.getByText(/1 reply handled for you since joining/)).toBeInTheDocument();
    expect(screen.getByText(/about 1 hour back in your day/)).toBeInTheDocument();
  });
});

describe('ReputationHeroBand info tips (#1086)', () => {
  function renderHero() {
    return render(
      <ReputationHeroBand
        summary={baseSummary}
        lifetimeReviewsHandled={1284}
        lifetimeTimeSavedMinutes={3120}
        connected
      />,
    );
  }

  function panelFor(name: string) {
    const trigger = screen.getByRole('button', { name });
    return document.getElementById(trigger.getAttribute('aria-controls') as string);
  }

  // Average rating: the window, not the all-time Google score.
  // Time saved: an estimate, and the tip names the constant behind it, so the
  // figure is not mistaken for a measurement.
  it('every covered surface names what its number means', () => {
    renderHero();

    const rating = panelFor('What Average rating means');
    expect(rating).toHaveTextContent('last 30 days');
    expect(rating).toHaveTextContent('not your all-time rating on Google');

    const saved = panelFor('What Time saved means');
    expect(saved).toHaveTextContent('An estimate');
    expect(saved).toHaveTextContent(String(MINUTES_SAVED_PER_RESPONSE));
  });

  // Assumption 4: a tip is warranted only where a better label or an existing
  // sentence will not do. Response rate already carries one, right below.
  it('gives response rate no tip, because a sentence already explains it', () => {
    renderHero();

    expect(screen.queryByRole('button', { name: 'What Response rate means' })).toBeNull();
    expect(screen.getByText(RESPONSE_RATE_PERIOD_CONTEXT)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^What .* means$/ })).toHaveLength(2);
  });
});
