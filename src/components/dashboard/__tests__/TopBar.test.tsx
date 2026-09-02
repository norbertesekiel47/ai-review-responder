// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { liveStatusLabel, TopBar } from '@/components/dashboard/shell/TopBar';
import { RefreshHoldProvider, useRefreshHold } from '@/components/dashboard/shell/refresh-hold';
import { LocationProvider } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));

const LOC_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' as LocationId;

function wrapWithProvider(ui: React.ReactElement) {
  return h(
    LocationProvider,
    {
      locations: [{ id: LOC_A, name: 'Test Biz', displayLabel: null, isPrimary: true }],
      initialScope: LOC_A,
      multiLocationEnabled: false,
      children: ui,
    },
  );
}

/** A row that is "mid-edit" for the whole test. */
function Holder() {
  useRefreshHold(true);
  return null;
}

describe('TopBar', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('exposes the page title as the primary heading', () => {
    render(wrapWithProvider(<TopBar title="Dashboard" subtitle="Your reputation overview" />));

    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  // UX audit D31: a static pill — no per-second countdown re-render.
  it('auto refreshes once a minute and keeps a static "updated just now" pill in between', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    render(wrapWithProvider(<TopBar title="Dashboard" showLive refresh={refresh} />));
    expect(screen.getByRole('status')).toHaveTextContent('Live · updated just now');

    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Live · updated just now');
    expect(screen.queryByText(/syncs in/)).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  // UX audit D1: a row mid-edit pauses the auto-refresh; manual Refresh still works.
  it('skips the auto refresh while a row holds it, and says so', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();

    render(wrapWithProvider(
      <RefreshHoldProvider>
        <Holder />
        <TopBar title="Reviews" showLive refresh={refresh} />
      </RefreshHoldProvider>,
    ));
    expect(screen.getByRole('status')).toHaveTextContent('Live · paused while you edit');

    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      screen.getByRole('button', { name: /refresh/i }).click();
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reflects the data hook\'s refreshing flag in the pill', () => {
    render(wrapWithProvider(<TopBar title="Reviews" showLive refresh={vi.fn()} refreshing />));
    expect(screen.getByRole('status')).toHaveTextContent('Live · updating…');
  });

  // UX audit D28: a right-side link may carry its own icon.
  it('renders rightLink as a link with the given label', () => {
    render(wrapWithProvider(
      <TopBar title="Contacts" rightLink={{ href: '/dashboard/requests', label: 'Back to Requests', icon: 'trend' }} />,
    ));
    expect(screen.getByRole('link', { name: /back to requests/i })).toHaveAttribute('href', '/dashboard/requests');
  });
});

describe('liveStatusLabel', () => {
  it('orders hold > refreshing > age', () => {
    expect(liveStatusLabel({ held: true, refreshing: true, minutesSinceRefresh: 3 })).toBe('Live · paused while you edit');
    expect(liveStatusLabel({ held: false, refreshing: true, minutesSinceRefresh: 3 })).toBe('Live · updating…');
    expect(liveStatusLabel({ held: false, refreshing: false, minutesSinceRefresh: 0 })).toBe('Live · updated just now');
    expect(liveStatusLabel({ held: false, refreshing: false, minutesSinceRefresh: 2 })).toBe('Live · updated 2 min ago');
  });
});
