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

// #678 retired PAST_REPLIES_VIEW_ENABLED, so there is no `historyEnabled` prop
// and no hidden-tab case left to test — the second tab is now `All Reviews` and
// always renders.
describe('ReviewsTabs', () => {
  it('renders both tabs with correct hrefs', () => {
    render(<ReviewsTabs active="needs" />);
    expect(linkByName(/needs action/i)).toHaveAttribute('href', '/dashboard/reviews');
    expect(linkByName(/all reviews/i)).toHaveAttribute('href', '/dashboard/reviews/history');
  });

  it('highlights the active tab and marks it aria-current=page (needs)', () => {
    render(<ReviewsTabs active="needs" />);
    expect(linkByName(/needs action/i)).toHaveClass('active');
    expect(linkByName(/needs action/i)).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/all reviews/i)).not.toHaveClass('active');
    expect(linkByName(/all reviews/i)).not.toHaveAttribute('aria-current');
  });

  it('highlights the active tab and marks it aria-current=page (history)', () => {
    render(<ReviewsTabs active="history" />);
    expect(linkByName(/all reviews/i)).toHaveClass('active');
    expect(linkByName(/all reviews/i)).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });
});

// #1092. The `tabs--routed` marker is a hand-typed string at three call sites
// and was asserted at only one of them (standards review, 2026-09-03). Dropping
// it here would leave the suite green while restoring the desktop double-nav
// that #1089 forbids.
describe('ReviewsTabs — the routed breakpoint marker', () => {
  it('carries tabs--routed so the breakpoint rule can reach it', () => {
    const { container } = render(<ReviewsTabs active="needs" />);
    expect(container.querySelector('.tabs--routed')).not.toBeNull();
  });
});

