// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CardViewTabs } from '@/components/dashboard/charts/CardViewTabs';

const VIEWS = [
  { value: 'total', label: 'Total' },
  { value: 'stacked', label: 'By Location' },
] as const;

function Harness() {
  const [mode, setMode] = useState<'total' | 'stacked'>('total');
  return (
    <CardViewTabs label="Review velocity view" value={mode} onChange={setMode} options={VIEWS}>
      <p>{mode === 'total' ? 'total panel' : 'stacked panel'}</p>
    </CardViewTabs>
  );
}

describe('CardViewTabs', () => {
  it('announces as one tablist, not a pair of independent toggles', () => {
    render(<Harness />);

    const list = screen.getByRole('tablist', { name: 'Review velocity view' });
    expect(list).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    // The old shape said "two toggle buttons" instead of "one of these two".
    expect(tabs[0]).not.toHaveAttribute('aria-pressed');
  });

  it('points the panel at the selected tab', () => {
    render(<Harness />);

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('total panel');
    expect(panel.getAttribute('aria-labelledby')).toBe(
      screen.getByRole('tab', { name: 'Total' }).id,
    );
  });

  it('keeps exactly one tab in the tab order', () => {
    render(<Harness />);

    expect(screen.getByRole('tab', { name: 'Total' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'By Location' })).toHaveAttribute('tabindex', '-1');
  });

  it('switches the panel on click', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('tab', { name: 'By Location' }));

    expect(screen.getByRole('tabpanel')).toHaveTextContent('stacked panel');
    expect(screen.getByRole('tab', { name: 'By Location' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('moves selection with the arrow keys and wraps at the ends', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    screen.getByRole('tab', { name: 'Total' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('stacked panel');

    // Wraps back to the first tab rather than stopping at the end.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('total panel');

    await user.keyboard('{End}');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('stacked panel');

    await user.keyboard('{Home}');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('total panel');
  });
});
