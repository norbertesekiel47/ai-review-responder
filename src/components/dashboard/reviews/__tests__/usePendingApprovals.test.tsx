// @vitest-environment jsdom
// UX audit D2: the queue hook pages through the pending-approvals read.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { usePendingApprovals } from '@/components/dashboard/reviews/usePendingApprovals';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

function item(id: string) {
  return {
    id,
    reviewerName: 'R',
    starRating: 5,
    reviewText: null,
    reviewDate: '2026-07-01T00:00:00.000Z',
    status: 'pending_approval',
    responseText: 'hi',
    responseStatus: 'pending_approval',
    approvalMethod: null,
    autoPostScheduledAt: null,
    escalation: null,
  };
}

describe('usePendingApprovals', () => {
  it('fetches the first page for the scope and exposes the totals', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      items: [item('r1')], total: 1, pendingTotal: 1, limit: 50, offset: 0,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePendingApprovals('all'), { wrapper: wrapper() });
    expect(result.current.loading).toBe(true);
    expect(result.current.items).toBeNull();

    await waitFor(() => expect(result.current.items).not.toBeNull());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/dashboard/reviews/pending?scope=all');
    expect(result.current.items).toHaveLength(1);
    expect(result.current.total).toBe(1);
    expect(result.current.pendingTotal).toBe(1);
    expect(result.current.hasMore).toBe(false);
  });

  it('offers Load more while total exceeds the loaded rows and appends the next page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [item('r1')], total: 2, pendingTotal: 2, limit: 1, offset: 0 }))
      .mockResolvedValueOnce(jsonResponse({ items: [item('r2')], total: 2, pendingTotal: 2, limit: 1, offset: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => usePendingApprovals(null), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.items).not.toBeNull());
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/dashboard/reviews/pending?offset=1');
    expect(result.current.hasMore).toBe(false);
  });

  it('surfaces the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'No active location available' }, 404)));

    const { result } = renderHook(() => usePendingApprovals(null), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toBe('No active location available');
    expect(result.current.loading).toBe(false);
  });
});
