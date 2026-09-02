// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PeriodToolbar } from '@/components/dashboard/analytics/PeriodToolbar';
import { DASHBOARD_WINDOWS } from '@/lib/kpi/types';

describe('PeriodToolbar', () => {
  it('renders one option per canonical window', () => {
    render(<PeriodToolbar value="30d" onChange={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(DASHBOARD_WINDOWS.length);
    expect(screen.getByRole('button', { name: '7 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '90 days' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '12 weeks' })).toBeInTheDocument();
  });

  it('marks the active window as pressed', () => {
    render(<PeriodToolbar value="90d" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '30 days' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('fires onChange with the picked window', () => {
    const onChange = vi.fn();
    render(<PeriodToolbar value="30d" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(onChange).toHaveBeenCalledWith('7d');
  });

  it('does not fire onChange when the already-active window is clicked', () => {
    const onChange = vi.fn();
    render(<PeriodToolbar value="30d" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('period pills on a phone (D36)', () => {
  it('wrap instead of scrolling behind a hidden scrollbar', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/app/(authenticated)/_styles/console.css'),
      'utf-8',
    );
    const phone = css.slice(css.indexOf('@media (max-width: 768px)'));
    expect(phone).toMatch(/\.period-toolbar \{[^}]*flex-wrap: wrap;/);
    expect(phone).not.toMatch(/\.period-toolbar \{ min-width: max-content; \}/);
    expect(phone).not.toMatch(/\.topbar-actions \{[^}]*overflow-x: auto;/);
  });
});
