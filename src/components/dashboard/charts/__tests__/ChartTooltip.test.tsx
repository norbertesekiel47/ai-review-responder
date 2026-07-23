// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartTooltip } from '@/components/dashboard/charts/ChartTooltip';

describe('ChartTooltip', () => {
  it('renders title and value centered on the anchor', () => {
    const { container } = render(<ChartTooltip x={300} y={120} title="Week of Jul 19" value="65 reviews" containerWidth={640} />);
    expect(screen.getByText('Week of Jul 19')).toBeInTheDocument();
    expect(screen.getByText('65 reviews')).toBeInTheDocument();
    const tip = container.querySelector<HTMLElement>('.chart-tip')!;
    expect(tip.getAttribute('aria-hidden')).toBe('true');
    expect(tip.style.left).toBe('252px'); // 300 − 96/2
    expect(tip.style.top).toBe('68px'); // 120 − 52
  });

  it('clamps inside the container at both edges', () => {
    const { container, rerender } = render(<ChartTooltip x={2} y={10} title="t" value="v" containerWidth={640} />);
    let tip = container.querySelector<HTMLElement>('.chart-tip')!;
    expect(tip.style.left).toBe('4px');
    expect(tip.style.top).toBe('4px');
    rerender(<ChartTooltip x={639} y={120} title="t" value="v" containerWidth={640} />);
    tip = container.querySelector<HTMLElement>('.chart-tip')!;
    expect(tip.style.left).toBe('540px'); // 640 − 96 − 4
  });
});
