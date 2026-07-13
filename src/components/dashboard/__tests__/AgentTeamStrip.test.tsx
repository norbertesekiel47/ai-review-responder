// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { AgentTeamStrip } from '@/components/dashboard/AgentTeamStrip';
import type { LocationId } from '@/lib/shared/ids';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return {
    queryClient,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  };
}

describe('AgentTeamStrip', () => {
  it('shows all three personas with their windowed activity counts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      window: '30d',
      reply: 12,
      guardian: 3,
      insights: 2,
    })));
    const { wrapper } = createWrapper();

    render(<AgentTeamStrip scope="all" />, { wrapper });

    expect(screen.getByRole('status')).toHaveTextContent('Loading agent activity');
    expect(await screen.findByText('12 replies posted')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your agent team' })).toBeInTheDocument();
    expect(screen.getByText('3 reviews escalated')).toBeInTheDocument();
    expect(screen.getByText('2 reports sent')).toBeInTheDocument();
    expect(screen.getAllByText('Last 30 days')).toHaveLength(3);
  });

  it('keeps zero-count agents visible as standing by', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      window: '30d',
      reply: 0,
      guardian: 0,
      insights: 0,
    })));
    const { wrapper } = createWrapper();

    render(<AgentTeamStrip scope="all" />, { wrapper });

    expect(await screen.findByText('Reply')).toBeInTheDocument();
    expect(screen.getByText('Guardian')).toBeInTheDocument();
    expect(screen.getByText('Insights')).toBeInTheDocument();
    expect(screen.getAllByText('Standing by')).toHaveLength(3);
  });

  it('uses distinct URLs and query keys when dashboard scope changes', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({
      window: '30d',
      reply: 1,
      guardian: 0,
      insights: 0,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { wrapper, queryClient } = createWrapper();
    const locationId = '11111111-1111-4111-8111-111111111111' as LocationId;

    const view = render(<AgentTeamStrip scope="all" />, { wrapper });
    await screen.findByText('1 reply posted');
    view.rerender(<AgentTeamStrip scope={locationId} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(queryClient.getQueryData(['dashboard-agent-team', locationId, '30d']))
        .toBeDefined();
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/dashboard/agent-team?scope=all&window=30d',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/dashboard/agent-team?scope=${locationId}&window=30d`,
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(queryClient.getQueryData(['dashboard-agent-team', 'all', '30d'])).toBeDefined();
  });

  it('reports failures without displaying invented metrics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(
      { error: 'Agent summary unavailable' },
      { status: 503 },
    )));
    const { wrapper } = createWrapper();

    render(<AgentTeamStrip scope="all" />, { wrapper });

    expect(await screen.findByRole('alert')).toHaveTextContent('Agent summary unavailable');
    expect(screen.queryByText('Reply')).not.toBeInTheDocument();
    expect(screen.queryByText(/replies posted/)).not.toBeInTheDocument();
  });

  it.each([
    ['a mismatched window', { window: '7d', reply: 1, guardian: 2, insights: 3 }],
    ['a negative count', { window: '30d', reply: -1, guardian: 2, insights: 3 }],
    ['a fractional count', { window: '30d', reply: 1.5, guardian: 2, insights: 3 }],
    ['a string count', { window: '30d', reply: '1', guardian: 2, insights: 3 }],
  ])('rejects %s without displaying metrics', async (_caseName, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
    const { wrapper } = createWrapper();

    render(<AgentTeamStrip scope="all" window="30d" />, { wrapper });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Agent activity response was incomplete',
    );
    expect(screen.queryByText('Reply')).not.toBeInTheDocument();
    expect(screen.queryByText(/replies posted/)).not.toBeInTheDocument();
  });
});
