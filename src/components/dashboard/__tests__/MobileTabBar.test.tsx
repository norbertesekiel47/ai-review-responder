// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MobileTabBar } from '@/components/dashboard/shell/MobileTabBar';

const { pathnameMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn<() => string>(() => '/dashboard'),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('@/contexts/PendingCountContext', () => ({
  usePendingCount: () => 0,
}));

const linkByName = (name: RegExp) => screen.getByRole('link', { name });

describe('MobileTabBar', () => {
  it('renders Home, Reviews, Settings (no History/Insights/Needs Action)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar solicitationEnabled={false} />);
    expect(linkByName(/home/i)).toHaveAttribute('href', '/dashboard');
    expect(linkByName(/reviews/i)).toHaveAttribute('href', '/dashboard/reviews');
    expect(linkByName(/settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /history/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /insights/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /needs action/i })).not.toBeInTheDocument();
  });

  it('marks Home active on /dashboard', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar solicitationEnabled={false} />);
    expect(linkByName(/home/i)).toHaveClass('active');
    expect(linkByName(/reviews/i)).not.toHaveClass('active');
  });

  it('renders the Analytics tab (final set: Home · Reviews · Analytics · Settings)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar solicitationEnabled={false} />);
    expect(linkByName(/analytics/i)).toHaveAttribute('href', '/dashboard/analytics');
  });

  it('marks Analytics active on /dashboard/analytics', () => {
    pathnameMock.mockReturnValue('/dashboard/analytics');
    render(<MobileTabBar solicitationEnabled={false} />);
    expect(linkByName(/analytics/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
    expect(linkByName(/reviews/i)).not.toHaveClass('active');
  });

  it('marks Reviews active on /dashboard/reviews', () => {
    pathnameMock.mockReturnValue('/dashboard/reviews');
    render(<MobileTabBar solicitationEnabled={false} />);
    expect(linkByName(/reviews/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('marks Reviews active on /dashboard/reviews/history', () => {
    pathnameMock.mockReturnValue('/dashboard/reviews/history');
    render(<MobileTabBar solicitationEnabled={false} />);
    expect(linkByName(/reviews/i)).toHaveClass('active');
  });

  it('hides the Requests tab when watch-mode is off', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar solicitationEnabled={false} />);
    expect(screen.queryByRole('link', { name: /requests/i })).not.toBeInTheDocument();
  });

  it('renders exactly one Requests tab, between Reviews and Analytics, when watch-mode is on', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar solicitationEnabled />);
    const requests = screen.getAllByRole('link', { name: /requests/i });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toHaveAttribute('href', '/dashboard/requests');

    const tabOrder = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(tabOrder.indexOf('/dashboard/reviews')).toBeLessThan(
      tabOrder.indexOf('/dashboard/requests'),
    );
    expect(tabOrder.indexOf('/dashboard/requests')).toBeLessThan(
      tabOrder.indexOf('/dashboard/analytics'),
    );
  });

  it('marks Requests active on /dashboard/requests without lighting up Home', () => {
    pathnameMock.mockReturnValue('/dashboard/requests');
    render(<MobileTabBar solicitationEnabled />);
    const requests = linkByName(/requests/i);
    expect(requests).toHaveClass('active');
    expect(requests).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('labels the nav and marks the active tab aria-current=page', () => {
    pathnameMock.mockReturnValue('/dashboard/reviews');
    render(<MobileTabBar solicitationEnabled={false} />);
    expect(screen.getByRole('navigation', { name: /dashboard/i })).toBeInTheDocument();
    expect(linkByName(/reviews/i)).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/settings/i)).not.toHaveAttribute('aria-current');
  });
});
