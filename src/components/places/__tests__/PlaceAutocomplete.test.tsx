// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  importLibraryMock,
  setOptionsMock,
  addEventListenerMock,
  removeEventListenerMock,
  removeElementMock,
} = vi.hoisted(() => ({
  importLibraryMock: vi.fn(),
  setOptionsMock: vi.fn(),
  addEventListenerMock: vi.fn(),
  removeEventListenerMock: vi.fn(),
  removeElementMock: vi.fn(),
}));

vi.mock('@googlemaps/js-api-loader', () => ({
  importLibrary: (...args: unknown[]) => importLibraryMock(...args),
  setOptions: (...args: unknown[]) => setOptionsMock(...args),
}));

import { PlaceAutocomplete } from '../PlaceAutocomplete';

let autocompleteElement: HTMLElement;

function makeAutocompleteElement(): HTMLElement {
  const element = document.createElement('div');
  const originalRemove = element.remove.bind(element);
  element.addEventListener = addEventListenerMock as unknown as typeof element.addEventListener;
  element.removeEventListener =
    removeEventListenerMock as unknown as typeof element.removeEventListener;
  removeElementMock.mockImplementation(() => {
    originalRemove();
  });
  element.remove = removeElementMock as unknown as typeof element.remove;
  autocompleteElement = element;
  return element;
}

describe('PlaceAutocomplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    importLibraryMock.mockResolvedValue({
      PlaceAutocompleteElement: function MockPlaceAutocompleteElement() {
        return makeAutocompleteElement();
      },
    });
  });

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('removes the gmp-select listener on unmount', async () => {
    const { unmount } = render(<PlaceAutocomplete onPlaceSelect={vi.fn()} />);

    await waitFor(() => {
      expect(addEventListenerMock).toHaveBeenCalledWith('gmp-select', expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
    expect(autocompleteElement.isConnected).toBe(true);

    // The listener is bound to an AbortSignal and detached by `abort()` in the
    // effect cleanup (react-doctor `effect-needs-cleanup`), so the proof is the
    // signal flipping to aborted, not a removeEventListener call.
    const listenerOptions = addEventListenerMock.mock.calls[0]![2] as { signal: AbortSignal };
    expect(listenerOptions.signal.aborted).toBe(false);

    unmount();

    expect(listenerOptions.signal.aborted).toBe(true);
    expect(removeElementMock).toHaveBeenCalledOnce();
    expect(autocompleteElement.isConnected).toBe(false);
  });

  it('ignores loader rejection after unmount', async () => {
    let rejectImport!: (reason: unknown) => void;
    const importFailure = new Promise((_resolve, reject) => {
      rejectImport = reject;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    importLibraryMock.mockReturnValueOnce(importFailure);

    try {
      const { queryByText, unmount } = render(
        <PlaceAutocomplete onPlaceSelect={vi.fn()} />,
      );

      unmount();

      await act(async () => {
        rejectImport(new Error('loader failed'));
        await importFailure.catch(() => undefined);
      });

      expect(
        queryByText('Failed to load Google Maps — use the URL input instead'),
      ).toBeNull();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not call onPlaceSelect when fetchFields resolves after unmount', async () => {
    const onPlaceSelect = vi.fn();
    const { unmount } = render(<PlaceAutocomplete onPlaceSelect={onPlaceSelect} />);

    await waitFor(() => {
      expect(addEventListenerMock).toHaveBeenCalledWith('gmp-select', expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
    const handler = addEventListenerMock.mock.calls[0]![1] as (event: Event) => Promise<void>;
    let resolveFetchFields!: () => void;
    const fetchFieldsPromise = new Promise<void>((resolve) => {
      resolveFetchFields = resolve;
    });
    const place = {
      id: 'place-123',
      formattedAddress: '123 Test St',
      location: {
        lat: () => 12.34,
        lng: () => 56.78,
      },
      fetchFields: vi.fn(() => fetchFieldsPromise),
    };

    const selectPromise = handler({
      placePrediction: {
        toPlace: () => place,
      },
    } as unknown as Event);

    unmount();
    resolveFetchFields();
    await selectPromise;

    expect(onPlaceSelect).not.toHaveBeenCalled();
  });

  async function selectPlace(address = '123 Test St') {
    await waitFor(() => {
      expect(addEventListenerMock).toHaveBeenCalledWith('gmp-select', expect.any(Function), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });
    const handler = addEventListenerMock.mock.calls[0]![1] as (event: Event) => Promise<void>;
    const place = {
      id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      formattedAddress: address,
      location: { lat: () => 12.34, lng: () => 56.78 },
      fetchFields: vi.fn(async () => undefined),
    };
    await act(async () => {
      await handler({ placePrediction: { toPlace: () => place } } as unknown as Event);
    });
  }

  it('confirms the address without ever rendering the Place ID (A13)', async () => {
    const { queryByText, getByText } = render(<PlaceAutocomplete onPlaceSelect={vi.fn()} />);
    await selectPlace();

    expect(getByText('123 Test St')).toBeInTheDocument();
    expect(queryByText(/Place ID/i)).toBeNull();
    expect(queryByText(/ChIJ/)).toBeNull();
  });

  it('colours the confirmation card with rw-success tokens and the error with rw-error, never raw green/red (A13)', async () => {
    const { container } = render(<PlaceAutocomplete onPlaceSelect={vi.fn()} />);
    await selectPlace();

    const card = container.querySelector('.border-rw-success\\/30');
    expect(card).not.toBeNull();
    expect(container.innerHTML).not.toMatch(/\b(text|bg|border)-(green|red)-\d+/);
  });

  it('gives the Clear control a 44px tap target and the actionable teal', async () => {
    const { getByRole } = render(<PlaceAutocomplete onPlaceSelect={vi.fn()} />);
    await selectPlace();

    const clear = getByRole('button', { name: 'Clear' });
    expect(clear.className).toContain('min-h-[44px]');
    expect(clear.className).toContain('text-rw-teal-strong');
  });

  it('sizes the Google input at 16px so iOS Safari does not zoom on focus (A13)', async () => {
    render(<PlaceAutocomplete onPlaceSelect={vi.fn()} />);
    const style = document.getElementById('gmp-autocomplete-light');
    expect(style).not.toBeNull();
    expect(style!.textContent).toMatch(/::part\(input\)\s*\{[^}]*font-size:\s*1rem/);
    expect(style!.textContent).not.toMatch(/font-size:\s*0\.875rem/);
  });

  it('announces a loader failure through an alert region in rw-error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    importLibraryMock.mockRejectedValueOnce(new Error('loader failed'));
    try {
      const { findByRole } = render(<PlaceAutocomplete onPlaceSelect={vi.fn()} />);
      const alert = await findByRole('alert');
      expect(alert).toHaveTextContent(/use the URL input instead/i);
      expect(alert.className).toContain('text-rw-error');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
