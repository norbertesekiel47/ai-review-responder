// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

  it('never sets preserveAspectRatio (measured-viewBox contract)', () => {
    render(<ReputationTrendChart trend={trendWith([4.3, 4.4, null, 4.6, 4.8])} />);
    const chart = screen.getByRole('img');
    expect(chart).not.toHaveAttribute('preserveAspectRatio');
    expect(chart.getAttribute('viewBox')).toBe('0 0 640 200'); // canonical width in jsdom (no ResizeObserver)
  });

  it('maps hover to the correct week across null-star gaps', () => {
    const trend = trendWith([4.3, null, 4.6, 4.8]);
    const { container } = render(<ReputationTrendChart trend={trend} />);
    const svg = container.querySelector('svg')!;
    // Canonical width 640 in jsdom; x scale spans LEFT=34 .. width-RIGHT=628 over trend indices 0..3.
    // Point for trend index 2 (star 4.6) sits at x = 34 + (2/3)*(628-34) = 430.
    // jsdom getBoundingClientRect() is all zeros, so clientX equals chart-space x directly.
    fireEvent.pointerMove(svg, { clientX: 430, clientY: 100 });
    const tip = container.querySelector('.chart-tip');
    expect(tip).not.toBeNull();
    expect(tip!.textContent).toContain('4.6');
    // Week label for trend[2] (weekStart 2026-04-03). The literal is safe now:
    // `weekLabel` pins `timeZone: 'UTC'`, so the label is 'Apr 3' in every zone.
    // It previously was NOT — this assertion used to recompute the expectation
    // the same way the component did, to dodge the very roll-back that made the
    // label wrong ("Apr 2" west of Greenwich). A symmetric expectation agrees
    // with the bug it is standing next to; a literal cannot.
    expect(tip!.textContent).toContain('Apr 3');
  });

  it('labels the week in UTC, not the viewer zone', () => {
    // Without `timeZone: 'UTC'` this reads "Apr 2" — a Thursday label on a
    // Friday bucket — for every owner west of Greenwich, which is most of them.
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      const trend = trendWith([4.3, null, 4.6, 4.8]);
      const { container } = render(<ReputationTrendChart trend={trend} />);
      fireEvent.pointerMove(container.querySelector('svg')!, { clientX: 430, clientY: 100 });
      expect(container.querySelector('.chart-tip')!.textContent).toContain('Week of Apr 3');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
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
