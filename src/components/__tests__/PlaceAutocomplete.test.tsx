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
      expect(addEventListenerMock).toHaveBeenCalledWith('gmp-select', expect.any(Function));
    });
    const handler = addEventListenerMock.mock.calls[0]![1];
    expect(autocompleteElement.isConnected).toBe(true);

    unmount();

    expect(removeEventListenerMock).toHaveBeenCalledWith('gmp-select', handler);
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
      expect(addEventListenerMock).toHaveBeenCalledWith('gmp-select', expect.any(Function));
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
});
