// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VelocityChart } from '@/components/dashboard/charts/VelocityChart';
import { computeVelocitySummary, weekShortLabel } from '@/components/dashboard/charts/velocity-math';

describe('computeVelocitySummary', () => {
  it('derives last week, delta, total, and 1-decimal average', () => {
    expect(computeVelocitySummary([0, 4, 8])).toEqual({ lastWeek: 8, deltaPct: 100, total: 12, avg: 4 });
    expect(computeVelocitySummary([5, 5])).toEqual({ lastWeek: 5, deltaPct: 0, total: 10, avg: 5 });
  });

  it('reports 0% delta when the previous week is zero or missing', () => {
    expect(computeVelocitySummary([0, 7]).deltaPct).toBe(0);
    expect(computeVelocitySummary([7]).deltaPct).toBe(0);
    expect(computeVelocitySummary([]).total).toBe(0);
  });
});

describe('weekShortLabel', () => {
  it('labels every other tick plus the final one', () => {
    expect(weekShortLabel('2026-07-13T00:00:00Z', 1, 8)).toBe('');
    expect(weekShortLabel('2026-07-13T00:00:00Z', 7, 8)).not.toBe('');
    expect(weekShortLabel('2026-07-13T00:00:00Z', 2, 8)).not.toBe('');
  });
});

describe('VelocityChart', () => {
  const data = [
    { id: '2026-05-31', label: 'May 31', count: 0 },
    { id: '2026-06-07', label: '', count: 2 },
    { id: '2026-06-14', label: 'Jun 14', count: 65 },
  ];

  it('renders one bar per datum with a measured-contract viewBox', () => {
    const { container } = render(<VelocityChart data={data} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 220'); // canonical in jsdom
    expect(svg.hasAttribute('preserveAspectRatio')).toBe(false);
    expect(container.querySelectorAll('rect').length).toBe(3);
    expect(screen.getAllByText('May 31')).toHaveLength(2);
  });

  it('renders the average reference line label', () => {
    render(<VelocityChart data={data} />);
    expect(screen.getByText(/avg 22.3/)).toBeInTheDocument();
  });

  it('renders safely with no data', () => {
    const { container } = render(<VelocityChart data={[]} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 220');
    expect(container.querySelectorAll('rect').length).toBe(0);
    expect(svg.innerHTML).not.toContain('NaN');
  });

  it('provides the weekly values to screen readers without exposing decorative SVG', () => {
    const { container } = render(<VelocityChart data={data} />);

    expect(screen.getByRole('table', { name: /review velocity history/i })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '65 reviews' })).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
