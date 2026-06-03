// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KpiCards } from '@/components/dashboard/kpi/KpiCards';

const baseSummary = {
  totalReviewsHandled: 412,
  totalTimeSavedMinutes: 1716, // 28.6h
  currentResponseRate: 96,
  baselineResponseRate: 78,
};

describe('KpiCards', () => {
  it('renders three tiles by default with the value-summary numbers', () => {
    render(<KpiCards valueSummary={baseSummary} pendingCount={0} onScrollToReviews={() => {}} />);
    expect(screen.getByText('Reviews handled')).toBeInTheDocument();
    expect(screen.getByText('Time saved')).toBeInTheDocument();
    expect(screen.getByText('Response rate')).toBeInTheDocument();
    expect(screen.queryByText('Pending approvals')).not.toBeInTheDocument();
  });

  it('shows the optional pending tile when pendingCount > 0', async () => {
    const onScroll = vi.fn();
    render(<KpiCards valueSummary={baseSummary} pendingCount={3} onScrollToReviews={onScroll} />);
    expect(screen.getByText('Pending approvals')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /review now/i }));
    expect(onScroll).toHaveBeenCalledOnce();
  });

  it('omits the baseline footnote when baselineResponseRate is null', () => {
    render(
      <KpiCards
        valueSummary={{ ...baseSummary, baselineResponseRate: null }}
        pendingCount={0}
        onScrollToReviews={() => {}}
      />,
    );
    expect(screen.queryByText(/before RepWorth/)).not.toBeInTheDocument();
  });
});
