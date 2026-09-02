// @vitest-environment jsdom
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaceSelection } from '@/components/places/PlaceAutocomplete';
import { StepLocation } from '../StepLocation';
import type { WizardFormData } from '../BusinessWizardClient';
import { initialWizardFormData } from '../payload';

// The Google widget is replaced by two fixed picks + a clear so the prefill
// choreography (first pick, re-pick, clear, stale response) can be driven.
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
      <button
        type="button"
        onClick={() =>
          onPlaceSelect({ placeId: 'place-b', formattedAddress: '2 B St', lat: 0, lng: 0 })
        }
      >
        pick B
      </button>
      <button type="button" onClick={onClear}>
        clear place
      </button>
    </div>
  ),
}));

afterEach(() => vi.unstubAllGlobals());

type Prefill = { category: string | null; website: string | null };

// One fetch stub per test: `place_id` → response. A `null` entry answers 502;
// every request honours its AbortSignal so a superseded fetch rejects the way
// the browser would.
function stubPrefill(byPlace: Record<string, Prefill | null>, latency = 0) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const placeId = new URL(url, 'http://localhost').searchParams.get('place_id')!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const body = byPlace[placeId];
        resolve(
          body === null
            ? { ok: false, status: 502, json: async () => ({}) }
            : { ok: true, status: 200, json: async () => body },
        );
      }, latency);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// A controlled harness that merges `update` patches the way the wizard does,
// so a second prefill sees the first prefill's values in `data`.
function Harness({
  dirty = { category: false, website: false },
  onUpdate = () => {},
  seed,
}: {
  dirty?: { category: boolean; website: boolean };
  onUpdate?: (patch: Partial<WizardFormData>) => void;
  seed?: Partial<WizardFormData>;
}) {
  const [data, setData] = useState<WizardFormData>({ ...initialWizardFormData(), ...seed });
  const dirtyRef = { current: dirty };
  return (
    <>
      <StepLocation
        stepLabel="Step 1 of 3 — Location"
        data={data}
        update={(patch) => {
          onUpdate(patch);
          setData((prev) => ({ ...prev, ...patch }));
        }}
        dirtyRef={dirtyRef}
        onNext={() => {}}
      />
      <output data-testid="category">{data.category}</output>
      <output data-testid="website">{data.website}</output>
      <output data-testid="placeId">{data.googlePlaceId}</output>
    </>
  );
}

describe('StepLocation — place prefill', () => {
  it('fills empty Profile fields from the first pick and shows the fetching notice meanwhile', async () => {
    stubPrefill({ 'place-a': { category: 'Cafe', website: 'https://a.example' } }, 5);
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));

    expect(screen.getByTestId('placeId')).toHaveTextContent('place-a');
    expect(screen.getByText(/fetching business details/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('category')).toHaveTextContent('Cafe'));
    expect(screen.getByTestId('website')).toHaveTextContent('https://a.example');
    expect(screen.queryByText(/fetching business details/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();
  });

  it('never overwrites a field the owner has edited', async () => {
    stubPrefill({ 'place-a': { category: 'Cafe', website: 'https://a.example' } });
    const onUpdate = vi.fn();
    render(
      <Harness
        dirty={{ category: true, website: false }}
        seed={{ category: 'My own words' }}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));

    await waitFor(() => expect(screen.getByTestId('website')).toHaveTextContent('https://a.example'));
    expect(screen.getByTestId('category')).toHaveTextContent('My own words');
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ category: expect.anything() }));
  });

  it('re-picking a different place overwrites an unedited prefill and clears a field the new place lacks', async () => {
    stubPrefill({
      'place-a': { category: 'Cafe', website: 'https://a.example' },
      'place-b': { category: 'Bar', website: null },
    });
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));
    await waitFor(() => expect(screen.getByTestId('category')).toHaveTextContent('Cafe'));

    fireEvent.click(screen.getByRole('button', { name: 'pick B' }));

    await waitFor(() => expect(screen.getByTestId('category')).toHaveTextContent('Bar'));
    // Place B has no website: the stale 'https://a.example' must not masquerade as B's.
    expect(screen.getByTestId('website')).toHaveTextContent('');
  });

  it('leaves the fields alone when the new place answers the same values', async () => {
    stubPrefill({
      'place-a': { category: 'Cafe', website: 'https://a.example' },
      'place-b': { category: 'Cafe', website: 'https://a.example' },
    });
    const onUpdate = vi.fn();
    render(<Harness onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));
    await waitFor(() => expect(screen.getByTestId('category')).toHaveTextContent('Cafe'));
    onUpdate.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'pick B' }));

    await waitFor(() => expect(screen.queryByText(/fetching business details/i)).toBeNull());
    // Only the place selection itself — no category/website patch.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ googlePlaceId: 'place-b', googlePlaceAddress: '2 B St' });
  });

  it('does not touch the fields when the prefill lookup fails', async () => {
    stubPrefill({ 'place-a': null });
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));

    await waitFor(() => expect(screen.queryByText(/fetching business details/i)).toBeNull());
    expect(screen.getByTestId('category')).toHaveTextContent('');
    expect(screen.getByTestId('website')).toHaveTextContent('');
  });

  it('aborts the superseded lookup when a second place is picked before the first answers', async () => {
    const fetchMock = stubPrefill(
      {
        'place-a': { category: 'Cafe', website: 'https://a.example' },
        'place-b': { category: 'Bar', website: 'https://b.example' },
      },
      10,
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));
    fireEvent.click(screen.getByRole('button', { name: 'pick B' }));

    await waitFor(() => expect(screen.getByTestId('category')).toHaveTextContent('Bar'));
    expect(screen.getByTestId('website')).toHaveTextContent('https://b.example');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSignal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    expect(firstSignal.aborted).toBe(true);
    expect(screen.queryByText(/fetching business details/i)).toBeNull();
  });

  it('cancels an in-flight lookup on unmount', async () => {
    const fetchMock = stubPrefill({ 'place-a': { category: 'Cafe', website: null } }, 50);
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));

    unmount();

    const signal = (fetchMock.mock.calls[0]![1] as RequestInit).signal!;
    expect(signal.aborted).toBe(true);
  });
});

describe('StepLocation — clearing and switching modes', () => {
  it('clearing the place resets the selection and any untouched prefilled fields', async () => {
    stubPrefill({ 'place-a': { category: 'Cafe', website: 'https://a.example' } });
    const onUpdate = vi.fn();
    render(<Harness onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));
    await waitFor(() => expect(screen.getByTestId('category')).toHaveTextContent('Cafe'));
    onUpdate.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'clear place' }));

    expect(onUpdate).toHaveBeenNthCalledWith(1, { googlePlaceId: '', googlePlaceAddress: '' });
    expect(onUpdate).toHaveBeenNthCalledWith(2, { category: '', website: '' });
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('clearing the place keeps a field the owner edited', () => {
    const onUpdate = vi.fn();
    render(<Harness dirty={{ category: true, website: false }} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'clear place' }));

    expect(onUpdate).toHaveBeenLastCalledWith({ website: '' });
  });

  it('clearing the place issues no reset when both fields are the owner\'s', () => {
    const onUpdate = vi.fn();
    render(<Harness dirty={{ category: true, website: true }} onUpdate={onUpdate} />);

    fireEvent.click(screen.getByRole('button', { name: 'clear place' }));

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith({ googlePlaceId: '', googlePlaceAddress: '' });
  });

  it('switching to a Maps URL drops the picked place; switching back drops the URL', async () => {
    stubPrefill({ 'place-a': { category: 'Cafe', website: null } }, 50);
    const onUpdate = vi.fn();
    render(<Harness onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole('button', { name: 'pick A' }));

    fireEvent.click(screen.getByRole('button', { name: /paste a google maps url/i }));

    expect(onUpdate).toHaveBeenLastCalledWith({
      inputMode: 'url',
      googlePlaceId: '',
      googlePlaceAddress: '',
    });
    // The pending lookup was cancelled with the mode switch.
    expect(screen.queryByText(/fetching business details/i)).toBeNull();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Google Maps URL'), {
      target: { value: 'https://maps.google.com/?cid=1' },
    });
    expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /use search instead/i }));

    expect(onUpdate).toHaveBeenLastCalledWith({ inputMode: 'autocomplete', googleMapsUrl: '' });
    await act(async () => {});
  });
});
