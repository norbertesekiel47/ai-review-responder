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
    expect(tip.style.left).toBe('242px'); // 300 − 116/2
    expect(tip.style.top).toBe('68px'); // 120 − 52
  });

  it('clamps inside the container at both edges', () => {
    const { container, rerender } = render(<ChartTooltip x={2} y={10} title="t" value="v" containerWidth={640} />);
    let tip = container.querySelector<HTMLElement>('.chart-tip')!;
    expect(tip.style.left).toBe('4px');
    expect(tip.style.top).toBe('4px');
    rerender(<ChartTooltip x={639} y={120} title="t" value="v" containerWidth={640} />);
    tip = container.querySelector<HTMLElement>('.chart-tip')!;
    expect(tip.style.left).toBe('520px'); // 640 − 116 − 4
  });

  it('renders the delta line only when provided, and lifts the tip for it', () => {
    const { container, rerender } = render(
      <ChartTooltip x={300} y={120} title="t" value="v" delta="↑ 2 vs prior week" containerWidth={640} />,
    );
    expect(screen.getByText('↑ 2 vs prior week')).toBeInTheDocument();
    let tip = container.querySelector<HTMLElement>('.chart-tip')!;
    expect(tip.style.top).toBe('54px'); // 120 − 52 − 14

    rerender(<ChartTooltip x={300} y={120} title="t" value="v" containerWidth={640} />);
    tip = container.querySelector<HTMLElement>('.chart-tip')!;
    expect(tip.querySelector('.chart-tip-delta')).toBeNull();
    expect(tip.style.top).toBe('68px');
  });
});
