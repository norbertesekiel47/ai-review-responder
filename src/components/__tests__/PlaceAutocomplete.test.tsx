// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  importLibraryMock,
  setOptionsMock,
  addEventListenerMock,
  removeEventListenerMock,
} = vi.hoisted(() => ({
  importLibraryMock: vi.fn(),
  setOptionsMock: vi.fn(),
  addEventListenerMock: vi.fn(),
  removeEventListenerMock: vi.fn(),
}));

vi.mock('@googlemaps/js-api-loader', () => ({
  importLibrary: (...args: unknown[]) => importLibraryMock(...args),
  setOptions: (...args: unknown[]) => setOptionsMock(...args),
}));

import { PlaceAutocomplete } from '../PlaceAutocomplete';

function makeAutocompleteElement(): HTMLElement {
  const element = document.createElement('div');
  element.addEventListener = addEventListenerMock as unknown as typeof element.addEventListener;
  element.removeEventListener =
    removeEventListenerMock as unknown as typeof element.removeEventListener;
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

    unmount();

    expect(removeEventListenerMock).toHaveBeenCalledWith('gmp-select', handler);
  });
});
