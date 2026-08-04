// @vitest-environment jsdom
//
// Focused suite for useBusinessDetail.clearBounceFlag — the admin's only path
// back from a bouncing owner email. It was untested: every branch (the confirm
// guard, the ok path, the two error shapes, and the network throw) reached the
// admin through an alert() nobody had pinned. The queries themselves are
// covered via BusinessDetailClient.test.tsx, so this suite seeds both with
// initialData and asserts only the PATCH behaviour.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// The hook calls router.refresh() from invalidate(); jsdom mounts no app router.
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

import { useBusinessDetail } from '../useBusinessDetail';
import type { ChannelEnrollmentRow, DetailData } from '@/app/admin/businesses/[id]/types';

const BUSINESS_ID = '00000000-0000-0000-0000-0000000000a1';
const PATCH_URL = `/api/admin/businesses/${BUSINESS_ID}`;

// Only clearBounceFlag is under test; the seeded detail is never read, it just
// keeps the two useQuery calls from firing their queryFn during the test.
const INITIAL_DETAIL = { business: { id: BUSINESS_ID } } as unknown as DetailData;
const INITIAL_CHANNELS: ChannelEnrollmentRow[] = [];

const fetchMock = vi.fn();
let confirmResult = true;
let alerts: string[] = [];

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mount() {
  return renderHook(
    () =>
      useBusinessDetail(BUSINESS_ID, {
        initialDetail: INITIAL_DETAIL,
        initialChannels: INITIAL_CHANNELS,
      }),
    { wrapper },
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  mockRefresh.mockReset();
  confirmResult = true;
  alerts = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', () => confirmResult);
  vi.stubGlobal('alert', (msg: string) => {
    alerts.push(msg);
  });
});

describe('useBusinessDetail — clearBounceFlag', () => {
  it('does nothing when the admin declines the confirm prompt', async () => {
    confirmResult = false;
    const { result } = mount();

    await result.current.clearBounceFlag();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
  });

  it('PATCHes ownerEmailBounced:false as JSON to the business detail route', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const { result } = mount();

    await result.current.clearBounceFlag();

    // The success path also invalidates the detail query, which refetches — so
    // select the PATCH rather than asserting a total call count.
    const patchCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(1);
    const [url, init] = patchCalls[0] as [string, RequestInit];
    expect(url).toBe(PATCH_URL);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ ownerEmailBounced: false });
  });

  it('refetches the detail query on success and raises no alert', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const { result } = mount();

    await result.current.clearBounceFlag();

    expect(alerts).toEqual([]);
    // The invalidation makes the seeded detail query stale, so it refetches —
    // observable as a second fetch against the same detail URL.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          (call) => call[0] === PATCH_URL && call[1] === undefined,
        ),
      ).toHaveLength(1),
    );
  });

  it('surfaces the server error message when the PATCH is rejected', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'business is archived' }),
    });
    const { result } = mount();

    await result.current.clearBounceFlag();

    expect(alerts).toEqual(['Failed to clear flag: business is archived']);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
    const { result } = mount();

    await result.current.clearBounceFlag();

    expect(alerts).toEqual(['Failed to clear flag: HTTP 502']);
    consoleSpy.mockRestore();
  });

  it('reports a network failure without rethrowing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = mount();

    await expect(result.current.clearBounceFlag()).resolves.toBeUndefined();

    expect(alerts).toEqual([
      'Failed to clear flag. Check your network connection and try again.',
    ]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('useBusinessDetail — invalidate', () => {
  it('calls router.refresh() so the server-rendered page chrome picks up edits', () => {
    const { result } = mount();

    result.current.invalidate();

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
