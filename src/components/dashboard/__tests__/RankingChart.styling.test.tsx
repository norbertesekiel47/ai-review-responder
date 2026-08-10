// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RankingChart } from '@/components/dashboard/kpi/RankingChart';
import type { RankingChartSeries } from '@/components/dashboard/kpi/RankingChart.helpers';

const series: RankingChartSeries[] = [
  {
    keyword: 'cafe near me',
    color: '#2563eb',
    points: [
      { date: '2026-05-01', label: 'May 1', position: 3 },
      { date: '2026-06-01', label: 'Jun 1', position: 2 },
    ],
  },
  {
    keyword: 'coffee shop',
    color: '#16a34a',
    points: [
      { date: '2026-05-01', label: 'May 1', position: 5 },
      { date: '2026-06-01', label: 'Jun 1', position: 4 },
    ],
  },
];

describe('RankingChart owner-series emphasis', () => {
  it('renders the primary series bold in sage and the rest faded (default)', () => {
    const { container } = render(<RankingChart series={series} />);
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBe(2);
    // Series 0 is the owner's headline line — bold sage; the rest recede.
    expect(paths[0]?.getAttribute('style')).toContain('var(--rw-sage-deep)');
    expect(paths[1]?.getAttribute('style')).toContain('var(--rw-app-text-soft)');
  });

  it('keeps per-series legend colors in aggregate (emphasis="series")', () => {
    const { container } = render(<RankingChart series={series} emphasis="series" />);
    const paths = container.querySelectorAll('path');
    // jsdom serializes hex stroke colors to rgb(); var() tokens are kept literal.
    expect(paths[0]?.getAttribute('style')).toContain('rgb(37, 99, 235)'); // #2563eb
    expect(paths[1]?.getAttribute('style')).toContain('rgb(22, 163, 74)'); // #16a34a
    expect(paths[0]?.getAttribute('style')).not.toContain('var(--rw-sage-deep)');
  });

  it('renders gridlines and axis text via tokenized CSS classes, not cool grays', () => {
    const { container } = render(<RankingChart series={series} />);
    expect(container.querySelector('line.rank-grid')).not.toBeNull();
    expect(container.querySelector('text.rank-axis')).not.toBeNull();
  });

  it('never sets preserveAspectRatio (measured-viewBox contract)', () => {
    const { container } = render(<RankingChart series={series} />);
    const svg = container.querySelector('svg')!;
    expect(svg.hasAttribute('preserveAspectRatio')).toBe(false);
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 240'); // canonical width in jsdom
  });

  it('provides the exact chart data to screen readers without exposing decorative SVG', () => {
    const { container } = render(<RankingChart series={series} />);

    expect(screen.getByRole('table', { name: /search ranking history/i })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '#2' })).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
