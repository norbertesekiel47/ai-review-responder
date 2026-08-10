// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationPicker } from '@/app/(authenticated)/dashboard/connect/select-location/LocationPicker';
import type { ZernioLocationOption } from '@/lib/zernio/types';

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const LOCATIONS: ZernioLocationOption[] = [
  { id: 'loc-1', name: 'Bristol Bay Coffee', address: '12 Harbor St' },
  { id: 'loc-2', name: 'Bristol Bay Roastery', address: '48 Cannery Row' },
];

function mockFetchResponse(response: Partial<Response> & { ok: boolean }) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function selectAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('radio', { name: /Bristol Bay Coffee/ }));
  await user.click(screen.getByRole('button', { name: 'Connect this location' }));
}

describe('LocationPicker', () => {
  beforeEach(() => {
    pushMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('disables submit until a location is selected', async () => {
    const user = userEvent.setup();
    render(<LocationPicker locations={LOCATIONS} />);

    const submit = screen.getByRole('button', { name: 'Connect this location' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: /Bristol Bay Roastery/ }));
    expect(submit).toBeEnabled();
  });

  it('POSTs the selection and navigates to the dashboard on success', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetchResponse({ ok: true });
    render(<LocationPicker locations={LOCATIONS} />);

    await selectAndSubmit(user);

    expect(fetchMock).toHaveBeenCalledWith('/api/zernio/connect/select-location', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locationId: 'loc-1' }),
    });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'));
  });

  it('maps a known error code to its friendly message', async () => {
    const user = userEvent.setup();
    mockFetchResponse({
      ok: false,
      json: () => Promise.resolve({ error: 'zernio_auth_error' }),
    } as unknown as Response & { ok: false });
    render(<LocationPicker locations={LOCATIONS} />);

    await selectAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google authorization expired before you finished. Please reconnect.',
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('falls back to a generic message with the raw code when unmapped', async () => {
    const user = userEvent.setup();
    mockFetchResponse({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    } as unknown as Response & { ok: false });
    render(<LocationPicker locations={LOCATIONS} />);

    await selectAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to connect (select_location_failed_500).',
    );
  });

  it('shows the network-error message when fetch rejects', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    render(<LocationPicker locations={LOCATIONS} />);

    await selectAndSubmit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Network error — please try again.',
    );
  });
});
