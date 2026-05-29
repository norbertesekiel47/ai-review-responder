// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MobileTabBar } from '../MobileTabBar';

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

describe('MobileTabBar — active tab state (M8)', () => {
  it('marks Home active on bare /dashboard (no hash)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/home/i)).toHaveClass('active');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });

  it('marks Needs Action active when the hash is #needs-action on mount', () => {
    pathnameMock.mockReturnValue('/dashboard');
    window.location.hash = '#needs-action';
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/needs action/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('activates Needs Action immediately on tap, without a hashchange event', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/home/i)).toHaveClass('active');
    act(() => {
      linkByName(/needs action/i).click();
    });
    expect(linkByName(/needs action/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('responds to hashchange events (browser back/forward)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar pastRepliesEnabled />);
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

  it('marks History active on /dashboard/past-replies; not Home/Needs Action', () => {
    pathnameMock.mockReturnValue('/dashboard/past-replies');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/history/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });

  it('marks Settings active on /settings; not Home/Needs Action', () => {
    pathnameMock.mockReturnValue('/settings');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/settings/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });

  it('removes hashchange and popstate listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<MobileTabBar pastRepliesEnabled />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
    removeSpy.mockRestore();
  });
});
