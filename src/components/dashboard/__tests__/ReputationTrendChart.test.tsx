// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReputationTrendChart } from '@/components/dashboard/kpi/ReputationTrendChart';
import type { ReputationSummary } from '@/lib/dashboard/types';

const trendWith = (stars: Array<number | null>): ReputationSummary['trend'] =>
  stars.map((starEquivalent, i) => ({
    weekStart: `2026-04-${String(i + 1).padStart(2, '0')}`,
    starEquivalent,
    reviewCount: starEquivalent == null ? 0 : 4,
  }));

describe('ReputationTrendChart', () => {
  it('renders a labelled line chart when trend data is present', () => {
    render(<ReputationTrendChart trend={trendWith([4.3, 4.4, null, 4.6, 4.8])} />);
    expect(screen.getByText('Reputation trend')).toBeInTheDocument();
    expect(screen.getByText(/star-equivalent/)).toBeInTheDocument();
    const chart = screen.getByRole('img');
    expect(chart).toHaveAttribute('aria-label', expect.stringContaining('Reputation trend'));
  });

  it('shows an empty state when every week is null', () => {
    render(<ReputationTrendChart trend={trendWith([null, null, null])} />);
    expect(screen.getByText(/Not enough reviews yet/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
