// @vitest-environment jsdom
//
// UX audit D36: the chart's span label follows the series length instead of a
// hard-coded "last 8 weeks" — the series follows the period picker.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ReputationTrendChart } from '@/components/dashboard/kpi/ReputationTrendChart';
import { trendSpanLabel } from '@/components/dashboard/charts/star-trend-plot';
import type { ReputationSummary } from '@/lib/dashboard/types';

function weeks(n: number): ReputationSummary['trend'] {
  return Array.from({ length: n }, (_, i) => ({
    weekStart: `2026-0${1 + Math.floor(i / 4)}-${String(1 + (i % 4) * 7).padStart(2, '0')}`,
    starEquivalent: 4 + (i % 3) * 0.2,
    reviewCount: 3,
  }));
}

describe('ReputationTrendChart span label (D36)', () => {
  it('names the number of weeks actually plotted', () => {
    render(<ReputationTrendChart trend={weeks(12)} />);
    expect(screen.getByText('star-equivalent · last 12 weeks')).toBeInTheDocument();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('last 12 weeks');
    expect(screen.getByText('12 weeks ago')).toBeInTheDocument();
    expect(screen.queryByText(/8 weeks/)).toBeNull();
  });

  it('trendSpanLabel handles the singular', () => {
    expect(trendSpanLabel(1)).toBe('last week');
    expect(trendSpanLabel(8)).toBe('last 8 weeks');
  });
});
