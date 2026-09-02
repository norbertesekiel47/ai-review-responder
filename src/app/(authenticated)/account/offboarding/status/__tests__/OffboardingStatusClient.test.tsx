// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { fireEvent, waitFor } from '@testing-library/react';
import { OffboardingStatusClient } from '../OffboardingStatusClient';
import { offboardingTone } from '@/components/dashboard/account-state/OffboardingStatusBanner';

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    accountTimeZone: 'UTC',
    activeOffboarding: {
      mode: 'cancel_only',
      status: 'scheduled',
      failedStep: null,
      accessEndsAt: '2026-07-01T16:00:00.000Z',
      teardownStartedAt: null,
      purgeAfter: null,
      operationalUIBlocked: true,
      ...overrides,
    },
  };
}

describe('OffboardingStatusClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads status and renders only safe offboarding status details', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      enabled: true,
      accountTimeZone: 'America/New_York',
      activeOffboarding: {
        id: 'offboarding-row-id-should-not-render',
        accountId: 'account-id-should-not-render',
        mode: 'delete_data',
        status: 'pending',
        failedStep: null,
        accessEndsAt: '2026-07-01T16:00:00.000Z',
        teardownStartedAt: null,
        purgeAfter: '2026-07-10T17:30:00.000Z',
        operationalUIBlocked: true,
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderWithQueryClient(<OffboardingStatusClient />);

    expect(await screen.findByText('Account deletion is in progress')).toBeInTheDocument();
    expect(screen.getByText(/Deletion window ends Jul 10, 2026, 1:30 PM EDT/i)).toBeInTheDocument();
    expect(screen.getByText(/limited billing, security, and compliance records may be retained/i)).toBeInTheDocument();
    expect(screen.queryByText(/offboarding-row-id-should-not-render/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/account-id-should-not-render/i)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/account/offboarding/status', {
      headers: { Accept: 'application/json' },
    });
  });
});

describe('OffboardingStatusClient — live status (D29)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paints a scheduled, owner-requested cancellation calm — red is reserved for failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(statusBody())));
    renderWithQueryClient(<OffboardingStatusClient />);

    const title = await screen.findByText('Account cancellation is scheduled');
    const banner = title.closest('.sub-status-banner');
    expect(banner).toHaveClass('sub-status-banner--trial');
    expect(banner).not.toHaveClass('sub-status-banner--cancelled');
    expect(banner).toHaveAttribute('data-tone', 'calm');
    expect(screen.getByText('Cancellation scheduled')).toBeInTheDocument();
  });

  it('paints a failed teardown red with the alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(statusBody({ status: 'failed', failedStep: 'purge' }))),
    );
    renderWithQueryClient(<OffboardingStatusClient />);

    const title = await screen.findByText('Offboarding needs support review');
    expect(title.closest('.sub-status-banner')).toHaveClass('sub-status-banner--cancelled');
    expect(offboardingTone({ status: 'failed' })).toBe('failed');
    expect(offboardingTone({ status: 'purge_scheduled' })).toBe('calm');
    expect(offboardingTone({ status: 'pending' })).toBe('calm');
  });

  it('offers a manual check that re-reads the status, and says when it last checked', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(statusBody()));
    vi.stubGlobal('fetch', fetchMock);
    renderWithQueryClient(<OffboardingStatusClient />);

    await screen.findByText('Account cancellation is scheduled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent(/checks for updates on its own/i);
    expect(screen.getByRole('status')).toHaveTextContent(/last checked/i);

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('polls on an interval while a teardown is active', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(statusBody()));
      vi.stubGlobal('fetch', fetchMock);
      renderWithQueryClient(<OffboardingStatusClient />);

      await screen.findByText('Account cancellation is scheduled');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    } finally {
      vi.useRealTimers();
    }
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}
