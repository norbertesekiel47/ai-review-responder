// @vitest-environment jsdom
// UX audit D32: the skeleton mirrors the page's zones with the page's own
// layout classes, so it collapses on a phone the way the content does.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardSkeleton } from '@/components/dashboard/shell/DashboardSkeleton';

describe('DashboardSkeleton', () => {
  it('uses the hero-row and dash-pair grids instead of an inline three-column grid', () => {
    const { container } = render(<DashboardSkeleton />);
    const root = container.firstElementChild!;

    expect(root).toHaveClass('dashboard-skeleton');
    expect(root.querySelector('.hero-row')).not.toBeNull();
    expect(root.querySelector('.hero-row')!.children).toHaveLength(2);
    expect(root.querySelector('.dash-pair')).not.toBeNull();
    expect(root.querySelector('.dash-pair')!.children).toHaveLength(2);

    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      expect(element.style.gridTemplateColumns).toBe('');
    }
  });
});
