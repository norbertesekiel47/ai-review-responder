// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createElement } from 'react';

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

// Mock the heavy island shell so these tests exercise DemoStatusIsland's own
// behavior (poller + CTAs), not PageShell's scroll internals.
vi.mock('@/components/ui/PageShell', () => ({
  PageShell: ({ children }: { children: React.ReactNode }) =>
    createElement('div', { 'data-testid': 'page-shell' }, children),
}));
vi.mock('@/components/ui/SiteNav', () => ({
  SiteNav: () => createElement('nav', { 'data-testid': 'site-nav' }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));

const { DemoStatusIsland } = await import('../DemoStatusIsland');

describe('DemoStatusIsland', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('loading variant polls the route on a backoff schedule and clears it on unmount', () => {
    vi.useFakeTimers();
    // Pin jitter to 0 so the backoff delays are deterministic (5s, 6s, …).
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { unmount } = render(
      createElement(DemoStatusIsland, {
        variant: 'loading',
        businessName: "Joe's Coffee",
        selfServeEnabled: false,
      }),
    );
    expect(mockRefresh).not.toHaveBeenCalled();
    // First poll fires at the 5s base delay.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    // Next gap grows (~6s), so 5s more is not yet enough for a second poll.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    unmount();
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('loading variant stops polling after the attempt cap and shows a recovery state', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    render(
      createElement(DemoStatusIsland, {
        variant: 'loading',
        businessName: "Joe's Coffee",
        selfServeEnabled: false,
      }),
    );
    // Drain well past the bounded schedule (cap is ~3.5 min of attempts).
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    const cappedCalls = mockRefresh.mock.calls.length;
    expect(cappedCalls).toBeGreaterThan(0);
    expect(cappedCalls).toBeLessThanOrEqual(24);
    // Once capped, advancing further must not poll again.
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(cappedCalls);
    expect(screen.getByText(/taking longer than usual/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('loading variant shows the business name and generating copy', () => {
    render(
      createElement(DemoStatusIsland, {
        variant: 'loading',
        businessName: "Joe's Coffee",
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText("Joe's Coffee")).toBeInTheDocument();
    expect(screen.getByText(/being generated/i)).toBeInTheDocument();
  });

  it('error variant offers both a retry and a recovery CTA, and does not poll', () => {
    vi.useFakeTimers();
    render(
      createElement(DemoStatusIsland, {
        variant: 'error',
        businessName: "Joe's Coffee",
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /book a demo/i })).toHaveAttribute('href', '/book-a-demo');
    expect(screen.getByRole('link', { name: /back to repworth/i })).toHaveAttribute('href', '/');
    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('expired variant renders the expired message and recovery CTA', () => {
    render(
      createElement(DemoStatusIsland, {
        variant: 'expired',
        selfServeEnabled: false,
      }),
    );
    expect(screen.getByText(/this demo link has expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /book a demo/i })).toHaveAttribute('href', '/book-a-demo');
  });

  it('loading variant omits the business name heading when not provided', () => {
    render(createElement(DemoStatusIsland, { variant: 'loading', selfServeEnabled: false }));
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByText(/being generated/i)).toBeInTheDocument();
  });

  it('error variant body copy omits the business name when not provided', () => {
    render(createElement(DemoStatusIsland, { variant: 'error', selfServeEnabled: false }));
    expect(screen.queryByText(/for undefined/i)).not.toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });
});
