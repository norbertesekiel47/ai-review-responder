// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReviewsTabs } from '@/components/dashboard/reviews/ReviewsTabs';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const linkByName = (name: RegExp) => screen.getByRole('link', { name });

describe('ReviewsTabs', () => {
  it('renders both tabs with correct hrefs when historyEnabled', () => {
    render(<ReviewsTabs active="needs" historyEnabled />);
    expect(linkByName(/needs action/i)).toHaveAttribute('href', '/dashboard/reviews');
    expect(linkByName(/history/i)).toHaveAttribute('href', '/dashboard/reviews/history');
  });

  it('hides the History tab when historyEnabled is false', () => {
    render(<ReviewsTabs active="needs" historyEnabled={false} />);
    expect(linkByName(/needs action/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /history/i })).not.toBeInTheDocument();
  });

  it('highlights the active tab and marks it aria-current=page (needs)', () => {
    render(<ReviewsTabs active="needs" historyEnabled />);
    expect(linkByName(/needs action/i)).toHaveClass('active');
    expect(linkByName(/needs action/i)).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/history/i)).not.toHaveClass('active');
    expect(linkByName(/history/i)).not.toHaveAttribute('aria-current');
  });

  it('highlights the active tab and marks it aria-current=page (history)', () => {
    render(<ReviewsTabs active="history" historyEnabled />);
    expect(linkByName(/history/i)).toHaveClass('active');
    expect(linkByName(/history/i)).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });
});
