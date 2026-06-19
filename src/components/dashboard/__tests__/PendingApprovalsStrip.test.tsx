// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingApprovalsStrip } from '@/components/dashboard/kpi/PendingApprovalsStrip';

describe('PendingApprovalsStrip', () => {
  it('shows the pending count and a Review now CTA that scrolls', async () => {
    const onReview = vi.fn();
    render(<PendingApprovalsStrip count={3} onReview={onReview} />);
    expect(screen.getByText(/need your approval/)).toBeInTheDocument();
    expect(screen.getByText('3 drafts')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /review now/i }));
    expect(onReview).toHaveBeenCalledOnce();
  });

  it('uses singular copy for a single pending draft', () => {
    render(<PendingApprovalsStrip count={1} onReview={() => {}} />);
    expect(screen.getByText('1 draft')).toBeInTheDocument();
    expect(screen.getByText(/needs your approval/)).toBeInTheDocument();
  });

  it('shows the calm all-caught-up state with no CTA when count is 0', () => {
    render(<PendingApprovalsStrip count={0} onReview={() => {}} />);
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review now/i })).not.toBeInTheDocument();
  });

  it('hides the CTA when no onReview handler is provided (read-only)', () => {
    render(<PendingApprovalsStrip count={2} />);
    expect(screen.getByText('2 drafts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /review now/i })).not.toBeInTheDocument();
  });
});
