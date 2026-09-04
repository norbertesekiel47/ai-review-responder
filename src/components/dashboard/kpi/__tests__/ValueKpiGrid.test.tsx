// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ValueKpiGrid } from '@/components/dashboard/kpi/ValueKpiGrid';
import { RESPONSE_RATE_PERIOD_CONTEXT } from '@/components/dashboard/kpi/response-rate-copy';
import { MINUTES_SAVED_PER_RESPONSE } from '@/lib/dashboard/constants';
import type { ValueSummary } from '@/lib/dashboard/types';

const summary: ValueSummary = {
  totalReviewsHandled: 1284,
  totalTimeSavedMinutes: 1284 * MINUTES_SAVED_PER_RESPONSE,
  currentResponseRate: 92,
  baselineResponseRate: 61,
};

function renderGrid() {
  return render(
    <ValueKpiGrid
      valueSummary={summary}
      reviewsHandledFoot="across 3 locations"
      timeSavedFoot="total across all locations"
    />,
  );
}

function panelFor(name: string) {
  const trigger = screen.getByRole('button', { name });
  return document.getElementById(trigger.getAttribute('aria-controls') as string);
}

describe('ValueKpiGrid info tips (#1086 aggregate scope)', () => {
  // This grid is the aggregate dashboard's headline row, and BOTH of these
  // numbers are lifetime (`total_responded_all_time`) while the per-location
  // hero's identically-named "Time saved" is windowed. An owner who lives on
  // "All Locations" reads a different metric under the same word.
  it('every covered surface names what its number means', () => {
    renderGrid();

    const handled = panelFor('What Reviews handled means');
    expect(handled).toHaveTextContent('since you joined');
    expect(handled).toHaveTextContent('not only this period');

    const saved = panelFor('What Time saved means');
    expect(saved).toHaveTextContent('An estimate');
    expect(saved).toHaveTextContent(String(MINUTES_SAVED_PER_RESPONSE));
    expect(saved).toHaveTextContent('since you joined');
  });

  // The lifetime/windowed distinction is the whole reason these tips exist,
  // so it is asserted rather than left to the prose.
  it('says lifetime, never borrowing the hero window wording', () => {
    renderGrid();

    for (const name of ['What Reviews handled means', 'What Time saved means']) {
      expect(panelFor(name)).not.toHaveTextContent('30 days');
    }
  });

  // Assumption 4, and the same call made for the hero's response rate: this
  // KPI already carries its explanation as a sentence, so a tip would repeat
  // it. Structural, so rewording InfoTip's label cannot silently unpin this.
  it('gives response rate no tip, because a sentence already explains it', () => {
    const { container } = renderGrid();

    expect(screen.getByText(RESPONSE_RATE_PERIOD_CONTEXT)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'What Response rate means' })).toBeNull();
    expect(container.querySelectorAll('.info-tip')).toHaveLength(2);
  });
});
