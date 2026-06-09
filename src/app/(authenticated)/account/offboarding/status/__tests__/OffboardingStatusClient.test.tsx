// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { OffboardingStatusClient } from '../OffboardingStatusClient';

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
