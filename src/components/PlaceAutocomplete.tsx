'use client';

import { useEffect, useRef, useState } from 'react';
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
}

// Guard against SSR — setOptions accesses `window` internally
if (typeof window !== 'undefined') {
  setOptions({
    key: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '',
    v: 'weekly',
    libraries: ['places'],
  });
}

export function PlaceAutocomplete({
  onPlaceSelect,
  onClear,
  placeholder = 'Search for a business...',
}: PlaceAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<PlaceSelection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let element: HTMLElement | null = null;
    let handleSelect: ((event: Event) => Promise<void>) | null = null;

    // Force light theme on the web component (system may be in dark mode)
    const styleId = 'gmp-autocomplete-light';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        gmp-place-autocomplete {
          color-scheme: light only !important;
          border-radius: 0.375rem;
        }
        gmp-place-autocomplete::part(input) {
          font-size: 0.875rem;
          line-height: 1.25rem;
        }
      `;
      document.head.appendChild(style);
    }

    importLibrary('places')
      .then((placesLib) => {
        if (cancelled || !containerRef.current) return;

        const PlaceAutocompleteElement = (placesLib as any).PlaceAutocompleteElement;

        element = new PlaceAutocompleteElement({
          includedPrimaryTypes: ['establishment'],
        }) as HTMLElement;

        element.setAttribute('placeholder', placeholder);
        element.style.width = '100%';

        handleSelect = async (event: Event) => {
          try {
            const { placePrediction } = event as any;
            if (!placePrediction) {
              setError('Failed to get place prediction');
              return;
            }

            const place = placePrediction.toPlace();
            await place.fetchFields({
              fields: ['id', 'formattedAddress', 'location'],
            });

            if (cancelled) return;

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
            if (cancelled) return;

            setError('Failed to load place details');
            console.error('[PlaceAutocomplete]', err);
          }
        };

        element.addEventListener('gmp-select', handleSelect);

        containerRef.current.innerHTML = '';
        containerRef.current.appendChild(element);
      })
      .catch((err: unknown) => {
        setError('Failed to load Google Maps — use the URL input instead');
        console.error('[PlaceAutocomplete] Load error:', err);
      });

    return () => {
      cancelled = true;
      if (element && handleSelect) {
        element.removeEventListener('gmp-select', handleSelect);
      }
      element?.remove();
    };
  }, [placeholder, onPlaceSelect]);

  const handleClear = () => {
    setSelection(null);
    setError(null);
    onClear?.();
  };

  return (
    <div>
      <div ref={containerRef} />

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
