'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';

export interface PlaceSelection {
  placeId: string;
  formattedAddress: string;
  lat: number;
  lng: number;
}

interface PlaceAutocompleteProps {
  onPlaceSelect: (selection: PlaceSelection) => void;
  onClear?: () => void;
  placeholder?: string;
  className?: string;
}

// Configure the loader once at module level.
// `key` is the correct option name in the functional API (not `apiKey`).
setOptions({
  key: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '',
  v: 'weekly',
  libraries: ['places'],
});

export function PlaceAutocomplete({
  onPlaceSelect,
  onClear,
  placeholder = 'Search for a business...',
  className,
}: PlaceAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<PlaceSelection | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelect = useCallback(
    async (event: Event) => {
      try {
        const customEvent = event as CustomEvent;
        const placePrediction =
          customEvent.detail?.placePrediction ??
          (customEvent as unknown as Record<string, unknown>)['placePrediction'];

        if (!placePrediction) {
          setError('Failed to get place prediction');
          return;
        }

        const place = (
          placePrediction as {
            toPlace: () => {
              fetchFields: (opts: { fields: string[] }) => Promise<void>;
              location: { lat: () => number; lng: () => number } | null;
              id: string | null;
              formattedAddress: string | undefined;
            };
          }
        ).toPlace();

        await place.fetchFields({ fields: ['id', 'formattedAddress', 'location'] });

        if (!place.location || !place.id) {
          setError('Place has no location data');
          return;
        }

        const result: PlaceSelection = {
          placeId: place.id,
          formattedAddress: place.formattedAddress ?? '',
          lat: place.location.lat(),
          lng: place.location.lng(),
        };

        setSelection(result);
        setError(null);
        onPlaceSelect(result);
      } catch (err: unknown) {
        setError('Failed to load place details');
        console.error('[PlaceAutocomplete]', err);
      }
    },
    [onPlaceSelect],
  );

  useEffect(() => {
    let autocompleteElement: HTMLElement | null = null;

    importLibrary('places')
      .then(() => {
        if (!containerRef.current) return;

        autocompleteElement = document.createElement('gmp-place-autocomplete');
        autocompleteElement.setAttribute('placeholder', placeholder);
        autocompleteElement.style.width = '100%';

        autocompleteElement.addEventListener('gmp-select', handleSelect);

        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(autocompleteElement);
      })
      .catch((err: unknown) => {
        setError('Failed to load Google Maps — you can use the URL input instead');
        console.error('[PlaceAutocomplete] Load error:', err);
      });

    return () => {
      if (autocompleteElement) {
        autocompleteElement.removeEventListener('gmp-select', handleSelect);
      }
    };
  }, [placeholder, handleSelect]);

  const handleClear = () => {
    setSelection(null);
    setError(null);
    onClear?.();
  };

  return (
    <div>
      <div ref={containerRef} className={className} />

      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}

      {selection && (
        <div className="mt-2 flex items-start justify-between rounded-md border border-green-200 bg-green-50 px-3 py-2">
          <div>
            <p className="text-sm font-medium text-green-900">
              {selection.formattedAddress}
            </p>
            <p className="text-xs text-green-700 mt-0.5">
              Place ID: {selection.placeId.slice(0, 20)}...
            </p>
          </div>
          <button
            type="button"
            onClick={handleClear}
            className="ml-2 text-xs text-green-600 hover:text-green-800"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
