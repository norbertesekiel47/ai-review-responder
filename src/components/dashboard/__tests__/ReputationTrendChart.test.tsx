// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReputationTrendChart, computeTrendDomain } from '@/components/dashboard/kpi/ReputationTrendChart';
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

  it('leads with a deterministic plain-English headline', () => {
    render(<ReputationTrendChart trend={trendWith([4.3, 4.4, null, 4.6, 4.8])} />);
    expect(screen.getByText(/Rating climbing/i)).toBeInTheDocument();
    expect(screen.getByText(/Now averaging 4.8 stars/i)).toBeInTheDocument();
  });

  it('shows an empty state when every week is null', () => {
    render(<ReputationTrendChart trend={trendWith([null, null, null])} />);
    expect(screen.getByText(/Not enough reviews yet/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('computeTrendDomain (Y-axis zoom)', () => {
  it('falls back to the full 1–5 range with no data', () => {
    expect(computeTrendDomain([])).toEqual({ min: 1, max: 5 });
  });

  it('zooms to the 4.x band instead of pinning 1–5', () => {
    const { min, max } = computeTrendDomain([4.3, 4.4, 4.6, 4.8]);
    expect(min).toBeCloseTo(4.1, 5);
    expect(max).toBeCloseTo(5, 5);
    // The whole point: a real ~0.5 swing fills the axis, not a flat 4-unit span.
    expect(max - min).toBeLessThan(1);
  });

  it('enforces a minimum span so a flat trend still reads', () => {
    const { min, max } = computeTrendDomain([4.5]);
    expect(max - min).toBeGreaterThanOrEqual(0.6 - 1e-9);
  });

  it('never escapes the [1,5] star range, even near the ceiling', () => {
    const { min, max } = computeTrendDomain([4.95]);
    expect(min).toBeGreaterThanOrEqual(1);
    expect(max).toBeLessThanOrEqual(5);
    expect(max - min).toBeGreaterThanOrEqual(0.6 - 1e-9);
  });
});
