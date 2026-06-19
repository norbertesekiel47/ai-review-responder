// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PendingApprovalsStrip } from '@/components/dashboard/kpi/PendingApprovalsStrip';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

describe('PendingApprovalsStrip', () => {
  it('shows the pending count and a Review now link to the Reviews page', () => {
    render(<PendingApprovalsStrip count={3} />);
    expect(screen.getByText(/need your approval/)).toBeInTheDocument();
    expect(screen.getByText('3 drafts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /review now/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
  });

  it('uses singular copy for a single pending draft', () => {
    render(<PendingApprovalsStrip count={1} />);
    expect(screen.getByText('1 draft')).toBeInTheDocument();
    expect(screen.getByText(/needs your approval/)).toBeInTheDocument();
  });

  it('shows the calm state with a View all reviews link when count is 0', () => {
    render(<PendingApprovalsStrip count={0} />);
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view all reviews/i })).toHaveAttribute(
      'href',
      '/dashboard/reviews',
    );
  });
});
