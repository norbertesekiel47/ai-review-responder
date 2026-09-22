// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { routerRefresh } = vi.hoisted(() => ({ routerRefresh: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh }),
}));

import { PaywallWithDemoClient } from '../PaywallWithDemoClient';
import { NO_DEMO_SENTINEL_STATUS, type OnboardingDemoViewStatus } from '@/lib/demos/types';

function demo(status: OnboardingDemoViewStatus) {
  return {
    id: 'demo-1',
    generation_status: status,
    completed_at: status === 'completed' ? '2026-09-01T00:00:00Z' : null,
    source: null,
    reviews_snapshot: [],
    generated_responses: [],
    business_name: 'Bella Vista',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  routerRefresh.mockClear();
});

describe('PaywallWithDemoClient — regenerate has a busy state and mapped failure copy (A14)', () => {
  it('shows a busy label and disables the retry while the request is in flight', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<PaywallWithDemoClient initialDemo={demo('failed')} isStale={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try the demo again' }));

    const busy = await screen.findByRole('button', { name: 'Starting a new demo…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
  });

  it('announces a mapped message on a 409 — never the raw code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ error: 'no_demo_to_regenerate' }),
      })),
    );
    render(<PaywallWithDemoClient initialDemo={demo('failed')} isStale={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try the demo again' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no finished demo to redo yet/i);
    expect(alert.textContent).not.toContain('no_demo_to_regenerate');
    // The control recovers so the owner can try again.
    expect(screen.getByRole('button', { name: 'Try the demo again' })).not.toBeDisabled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('treats a 200 with a cost_ceiling body as a failure, not a silent no-op', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: 'cost_ceiling' }),
      })),
    );
    render(<PaywallWithDemoClient initialDemo={demo('completed')} isStale={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate demo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/limit for sample demos/i);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('falls back to plain copy for an unknown code and to a connection message on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: 'weird_code' }) })),
    );
    const { unmount } = render(
      <PaywallWithDemoClient initialDemo={demo('completed')} isStale={false} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate demo' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('weird_code');
    expect(alert).toHaveTextContent(/something went wrong/i);
    unmount();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<PaywallWithDemoClient initialDemo={demo('completed')} isStale={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate demo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't reach repworth/i);
  });

  it('refreshes the page on success and keeps the control busy until the new status lands', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ demoId: 'demo-2' }) })),
    );
    render(<PaywallWithDemoClient initialDemo={demo('completed')} isStale={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate demo' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Regenerating…' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('carries the draft label on the actionable teal, not the decorative one', () => {
    const initialDemo = {
      ...demo('completed'),
      reviews_snapshot: [
        {
          reviewerName: 'Alex',
          reviewDate: '2026-08-01T00:00:00Z',
          starRating: 5,
          reviewText: 'Great!',
        },
      ],
      generated_responses: [{ responseText: 'Thank you, Alex!' }],
    };
    render(
      <PaywallWithDemoClient
        initialDemo={initialDemo as unknown as Parameters<typeof PaywallWithDemoClient>[0]['initialDemo']}
        isStale={false}
      />,
    );

    const label = screen.getByText('RepWorth draft reply');
    expect(label.className).toContain('text-rw-teal-strong');
    expect(label.className).not.toMatch(/(?:^|\s)text-rw-teal(?:\s|$)/);
  });
});

describe('PaywallWithDemoClient — no-demo sentinel (#1104)', () => {
  it('renders the paywall with the on-the-way copy, offers no retry, and never polls', () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(
        <PaywallWithDemoClient initialDemo={demo(NO_DEMO_SENTINEL_STATUS)} isStale={false} />,
      );

      expect(screen.getByText(/live demo is on the way after signup/i)).toBeInTheDocument();
      expect(screen.getByText('Choose your RepWorth plan')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try the demo again' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Regenerate demo' })).toBeNull();
      expect(screen.queryByText(/generating your demo/i)).toBeNull();

      // The status poller only arms for queued/running; the sentinel has no row
      // to poll (the status route answers 404), so no request may go out.
      vi.advanceTimersByTime(2000 * 3 + 100);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(routerRefresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
