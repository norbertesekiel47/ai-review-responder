// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MobileTabBar } from '@/components/dashboard/shell/MobileTabBar';
import { PendingCountProvider } from '@/contexts/PendingCountContext';

// Per-test control of the route. vi.hoisted runs before the hoisted vi.mock factory.
const { pathnameMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn<() => string>(() => '/dashboard'),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const linkByName = (name: RegExp) => screen.getByRole('link', { name });

afterEach(() => {
  pathnameMock.mockReturnValue('/dashboard');
  window.location.hash = '';
});

describe('MobileTabBar — four-tab structure (§2.3)', () => {
  it('renders exactly Home · Needs Action · Insights · Settings (no History tab)', () => {
    render(<MobileTabBar />);
    expect(linkByName(/home/i)).toBeInTheDocument();
    expect(linkByName(/needs action/i)).toBeInTheDocument();
    expect(linkByName(/insights/i)).toBeInTheDocument();
    expect(linkByName(/settings/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /history|past replies/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(4);
  });
});

describe('MobileTabBar — active tab state (single resolver)', () => {
  it('marks Home active on bare /dashboard (no hash)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar />);
    expect(linkByName(/home/i)).toHaveClass('active');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });

  it('marks Needs Action active when the hash is #needs-action on mount', () => {
    pathnameMock.mockReturnValue('/dashboard');
    window.location.hash = '#needs-action';
    render(<MobileTabBar />);
    expect(linkByName(/needs action/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('activates Needs Action immediately on tap, without a hashchange event', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar />);
    expect(linkByName(/home/i)).toHaveClass('active');
    act(() => {
      linkByName(/needs action/i).click();
    });
    expect(linkByName(/needs action/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('responds to hashchange events (browser back/forward)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar />);
    expect(linkByName(/home/i)).toHaveClass('active');
    act(() => {
      window.location.hash = '#needs-action';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(linkByName(/needs action/i)).toHaveClass('active');
    act(() => {
      window.location.hash = '';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(linkByName(/home/i)).toHaveClass('active');
  });

  it('marks Insights active on /dashboard/insights; not Home/Settings', () => {
    pathnameMock.mockReturnValue('/dashboard/insights');
    render(<MobileTabBar />);
    expect(linkByName(/insights/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
    expect(linkByName(/settings/i)).not.toHaveClass('active');
  });

  it('keeps Home active on /dashboard/connect (wizard maps to the home cluster)', () => {
    pathnameMock.mockReturnValue('/dashboard/connect');
    render(<MobileTabBar />);
    expect(linkByName(/home/i)).toHaveClass('active');
  });

  it('lights Home on /dashboard/past-replies — no mobile History tab, nearest ancestor wins', () => {
    pathnameMock.mockReturnValue('/dashboard/past-replies');
    render(<MobileTabBar />);
    expect(linkByName(/home/i)).toHaveClass('active');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });

  it('marks Settings active on /settings and /dashboard/add-location', () => {
    pathnameMock.mockReturnValue('/settings');
    const { unmount } = render(<MobileTabBar />);
    expect(linkByName(/settings/i)).toHaveClass('active');
    unmount();
    pathnameMock.mockReturnValue('/dashboard/add-location');
    render(<MobileTabBar />);
    expect(linkByName(/settings/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('shows the pending badge on Needs Action from PendingCountContext', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(
      <PendingCountProvider initialCount={3}>
        <MobileTabBar />
      </PendingCountProvider>,
    );
    expect(linkByName(/needs action/i)).toHaveTextContent('3');
  });

  it('removes hashchange and popstate listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<MobileTabBar />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
    removeSpy.mockRestore();
  });
});

describe('MobileTabBar — route-nav ARIA', () => {
  it('labels the nav and marks the active tab aria-current=page', () => {
    pathnameMock.mockReturnValue('/dashboard/insights');
    render(<MobileTabBar />);
    expect(screen.getByRole('navigation', { name: /dashboard/i })).toBeInTheDocument();
    expect(linkByName(/insights/i)).toHaveAttribute('aria-current', 'page');
    expect(linkByName(/settings/i)).not.toHaveAttribute('aria-current');
  });
});
