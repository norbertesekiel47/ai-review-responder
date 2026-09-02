// @vitest-environment jsdom
//
// Focused suite for useBusinessDetail.clearBounceFlag — the admin's only path
// back from a bouncing owner email. Every branch (the ok path, the two error
// shapes, and the network throw) lands in `bounceFlagState`, never a confirm()
// or alert() (X3): the inline notice owns the confirm step. The queries
// themselves are covered via BusinessDetailClient.test.tsx, so this suite
// seeds both with initialData and asserts only the PATCH behaviour.
//
// Also covers resendInvite (plan step 9 / T7), whose outcome is deliberately
// inline state rather than an alert()/confirm() dialog.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
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
const confirmSpy = vi.fn(() => true);
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
  confirmSpy.mockClear();
  alerts = [];
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', confirmSpy);
  vi.stubGlobal('alert', (msg: string) => {
    alerts.push(msg);
  });
});

describe('useBusinessDetail — clearBounceFlag', () => {
  it('starts idle, with no submitting state and no error', () => {
    const { result } = mount();
    expect(result.current.bounceFlagState).toEqual({ submitting: false, error: null });
  });

  it('PATCHes ownerEmailBounced:false as JSON with no confirm() dialog', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const { result } = mount();

    await act(async () => {
      await result.current.clearBounceFlag();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
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

  it('refetches the detail query on success, returns to idle, and raises no alert', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const { result } = mount();

    await act(async () => {
      await result.current.clearBounceFlag();
    });

    expect(alerts).toEqual([]);
    expect(result.current.bounceFlagState).toEqual({ submitting: false, error: null });
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

  it('surfaces the server error message inline when the PATCH is rejected', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'business is archived' }),
    });
    const { result } = mount();

    await act(async () => {
      await result.current.clearBounceFlag();
    });

    expect(alerts).toEqual([]);
    expect(result.current.bounceFlagState).toEqual({
      submitting: false,
      error: 'Failed to clear flag: business is archived',
    });
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

    await act(async () => {
      await result.current.clearBounceFlag();
    });

    expect(result.current.bounceFlagState.error).toBe('Failed to clear flag: HTTP 502');
    consoleSpy.mockRestore();
  });

  it('reports a network failure inline without rethrowing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = mount();

    await act(async () => {
      await expect(result.current.clearBounceFlag()).resolves.toBeUndefined();
    });

    expect(alerts).toEqual([]);
    expect(result.current.bounceFlagState.error).toBe(
      'Failed to clear flag. Check your network connection and try again.',
    );
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('clears the previous error when a second attempt starts', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: 'slow down' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const { result } = mount();

    await act(async () => {
      await result.current.clearBounceFlag();
    });
    expect(result.current.bounceFlagState.error).toBe('Failed to clear flag: slow down');

    await act(async () => {
      await result.current.clearBounceFlag();
    });
    expect(result.current.bounceFlagState).toEqual({ submitting: false, error: null });
    consoleSpy.mockRestore();
  });
});

describe('useBusinessDetail — resendInvite', () => {
  const RESEND_URL = `/api/admin/businesses/${BUSINESS_ID}/resend-invite`;

  it('POSTs to the resend-invite route with no confirm() dialog and no alert()', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, ownerEmailRedacted: 'a***@cafe.com' }),
    });
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);
    const { result } = mount();

    await act(async () => {
      await result.current.resendInvite();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alerts).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_URL);
    expect(init.method).toBe('POST');
    expect(result.current.resendInviteState).toEqual({
      submitting: false,
      message: 'Invite re-sent to a***@cafe.com.',
      error: null,
    });
  });

  it('surfaces the server-mapped error message inline instead of alerting', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'This owner has already signed in, so the invite was accepted.',
        code: 'OWNER_ALREADY_SIGNED_IN',
      }),
    });
    const { result } = mount();

    await act(async () => {
      await result.current.resendInvite();
    });

    expect(alerts).toEqual([]);
    expect(result.current.resendInviteState).toEqual({
      submitting: false,
      message: null,
      error: 'This owner has already signed in, so the invite was accepted.',
    });
  });

  it('falls back to the HTTP status when the resend error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
    const { result } = mount();

    await act(async () => {
      await result.current.resendInvite();
    });

    expect(result.current.resendInviteState.error).toBe('HTTP 502');
  });

  it('reports a resend network failure without rethrowing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { result } = mount();

    await act(async () => {
      await expect(result.current.resendInvite()).resolves.toBeUndefined();
    });

    expect(result.current.resendInviteState.error).toBe(
      'Failed to resend the invite. Check your network connection and try again.',
    );
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('clears the previous outcome when a second attempt starts', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: 'slow down' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    const { result } = mount();

    await act(async () => {
      await result.current.resendInvite();
    });
    expect(result.current.resendInviteState.error).toBe('slow down');

    await act(async () => {
      await result.current.resendInvite();
    });
    expect(result.current.resendInviteState).toEqual({
      submitting: false,
      message: 'Invite re-sent.',
      error: null,
    });
  });
});

describe('useBusinessDetail — invalidate', () => {
  it('calls router.refresh() so the server-rendered page chrome picks up edits', () => {
    const { result } = mount();

    result.current.invalidate();

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
