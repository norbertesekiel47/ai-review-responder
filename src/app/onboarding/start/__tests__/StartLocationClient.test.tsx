// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaceSelection } from '@/components/places/PlaceAutocomplete';
import {
  ONBOARDING_CONNECTION_FAILED,
  ONBOARDING_ERROR_COPY,
} from '@/app/onboarding/_shared/onboarding-error-copy';

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, refresh: vi.fn() }),
}));

// The Google widget is replaced by a fixed pick + clear so the reducer's
// selectPlace / clearPlace / prefill arms can be driven through the UI.
vi.mock('@/components/places/PlaceAutocomplete', () => ({
  PlaceAutocomplete: ({
    onPlaceSelect,
    onClear,
  }: {
    onPlaceSelect: (sel: PlaceSelection) => void;
    onClear?: () => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onPlaceSelect({ placeId: 'place-a', formattedAddress: '1 A St', lat: 0, lng: 0 })
        }
      >
        pick A
      </button>
      <button type="button" onClick={onClear}>
        clear place
      </button>
    </div>
  ),
}));

import { StartLocationClient } from '../StartLocationClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function jsonResponse(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Routes each URL to a canned response; the prefill answers `prefill`, the
// submit answers `start`, the analytics beacon is always accepted.
function stubFetch(routes: { prefill?: unknown; start?: unknown; startStatus?: number }) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/signup/place-prefill')) {
      return Promise.resolve(
        routes.prefill === null ? jsonResponse(502) : jsonResponse(200, routes.prefill),
      );
    }
    if (url === '/api/onboarding/start') {
      return Promise.resolve(jsonResponse(routes.startStatus ?? 200, routes.start ?? {}));
    }
    return Promise.resolve(jsonResponse(202));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>, url: string): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => c[0] === url)!;
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

const submitButton = () => screen.getByRole('button', { name: /generate my demo/i });

function typeName(name = 'Bella Vista') {
  fireEvent.change(screen.getByLabelText('Business name'), { target: { value: name } });
}

function switchToUrlAndPaste(url = 'https://maps.google.com/?cid=1') {
  fireEvent.click(screen.getByRole('button', { name: /paste a google maps url/i }));
  fireEvent.change(screen.getByLabelText('Google Maps URL'), { target: { value: url } });
}

describe('StartLocationClient — form state', () => {
  it('seeds the business name from the server and needs a location before it can submit', () => {
    render(<StartLocationClient initialBusinessName="Acme Dental" />);

    expect(screen.getByLabelText('Business name')).toHaveValue('Acme Dental');
    expect(submitButton()).toBeDisabled();
  });

  it('a blank business name keeps submit disabled even with a URL', () => {
    render(<StartLocationClient />);
    switchToUrlAndPaste();

    expect(submitButton()).toBeDisabled();
    typeName('   ');
    expect(submitButton()).toBeDisabled();
    typeName();
    expect(submitButton()).not.toBeDisabled();
  });

  it('switching modes drops the other mode\'s value so a stale place or URL cannot ride along', async () => {
    stubFetch({ prefill: { category: 'Cafe', website: null } });
    render(<StartLocationClient />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));
    expect(submitButton()).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /paste a google maps url/i }));
    expect(submitButton()).toBeDisabled(); // the picked place is gone
    fireEvent.change(screen.getByLabelText('Google Maps URL'), {
      target: { value: 'https://maps.google.com/?cid=1' },
    });
    expect(submitButton()).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /use search instead/i }));
    expect(submitButton()).toBeDisabled(); // the URL is gone too
    await waitFor(() => expect(screen.getByRole('button', { name: 'pick A' })).toBeInTheDocument());
  });

  it('clearing the picked place disables submit again', () => {
    stubFetch({ prefill: { category: 'Cafe', website: null } });
    render(<StartLocationClient />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));
    expect(submitButton()).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'clear place' }));

    expect(submitButton()).toBeDisabled();
  });
});

describe('StartLocationClient — submit', () => {
  it('POSTs the URL mode payload, records the demo start, and lands on /onboarding/demo', async () => {
    const fetchMock = stubFetch({});
    render(<StartLocationClient />);
    typeName();
    switchToUrlAndPaste();

    fireEvent.click(submitButton());

    expect(screen.getByRole('button', { name: /generating demo/i })).toBeDisabled();
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/onboarding/demo'));
    expect(postedBody(fetchMock, '/api/onboarding/start')).toEqual({
      inputMode: 'url',
      businessName: 'Bella Vista',
      googleMapsUrl: 'https://maps.google.com/?cid=1',
    });
    expect(postedBody(fetchMock, '/api/analytics/enqueue')).toMatchObject({
      eventName: 'sample_demo_started',
      properties: { source: 'onboarding_start', inputMode: 'url' },
    });
  });

  it('POSTs the picked place with its prefill, once the prefill has answered', async () => {
    const fetchMock = stubFetch({ prefill: { category: 'Cafe', website: 'https://a.example' } });
    render(<StartLocationClient />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/signup/place-prefill?place_id=place-a',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    // Let the prefill land before submitting.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));

    fireEvent.click(submitButton());

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/onboarding/demo'));
    expect(postedBody(fetchMock, '/api/onboarding/start')).toEqual({
      inputMode: 'autocomplete',
      businessName: 'Bella Vista',
      googlePlaceId: 'place-a',
      googlePlaceAddress: '1 A St',
      prefilledCategory: 'Cafe',
      prefilledWebsite: 'https://a.example',
    });
  });

  it('submits null prefill when the lookup failed', async () => {
    const fetchMock = stubFetch({ prefill: null });
    render(<StartLocationClient />);
    typeName();
    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));

    fireEvent.click(submitButton());

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/onboarding/demo'));
    expect(postedBody(fetchMock, '/api/onboarding/start')).toMatchObject({
      prefilledCategory: null,
      prefilledWebsite: null,
    });
  });

  it('follows a server redirectTo without recording a demo start', async () => {
    const fetchMock = stubFetch({ start: { redirectTo: '/onboarding/business' } });
    render(<StartLocationClient />);
    typeName();
    switchToUrlAndPaste();

    fireEvent.click(submitButton());

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/onboarding/business'));
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain('/api/analytics/enqueue');
  });

  it('shows owner copy for an API error code and re-enables the button', async () => {
    stubFetch({ startStatus: 400, start: { error: 'invalid_body' } });
    render(<StartLocationClient />);
    typeName();
    switchToUrlAndPaste();

    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(ONBOARDING_ERROR_COPY.invalid_body!);
    expect(submitButton()).not.toBeDisabled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('shows the connection-failed copy when the POST never reaches the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<StartLocationClient />);
    typeName();
    switchToUrlAndPaste();

    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(ONBOARDING_CONNECTION_FAILED);
    expect(routerPush).not.toHaveBeenCalled();
  });
});
