// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useOffboardingStatus } from '../useOffboardingStatus';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

it('loads status on mount', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ enabled: true, activeOffboarding: null }),
  });
  const { result } = renderHook(() => useOffboardingStatus());
  await waitFor(() => expect(result.current.status).not.toBeNull());
  expect(result.current.status).toEqual({ enabled: true, activeOffboarding: null });
});

it('surfaces a load error', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'boom' }) });
  const { result } = renderHook(() => useOffboardingStatus());
  await waitFor(() => expect(result.current.loadError).toBe('boom'));
});

it('setStatus updates the local snapshot without a fetch', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ enabled: true, activeOffboarding: null }),
  });
  const { result } = renderHook(() => useOffboardingStatus());
  await waitFor(() => expect(result.current.status).not.toBeNull());
  act(() => {
    result.current.setStatus({
      enabled: true,
      activeOffboarding: { id: 'x', mode: 'cancel_only', status: 'pending' },
    });
  });
  expect(result.current.status?.activeOffboarding?.mode).toBe('cancel_only');
});
