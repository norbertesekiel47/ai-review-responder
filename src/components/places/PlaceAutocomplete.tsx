'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
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
  ariaLabel?: string;
  ariaLabelledBy?: string;
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
  ariaLabel,
  ariaLabelledBy,
}: PlaceAutocompleteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<PlaceSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The mounted <gmp-place-autocomplete>; null until the Maps library has loaded.
  // Kept in state so the `gmp-select` subscription lives in its own effect below,
  // where add/remove are visibly paired in one body (react-doctor
  // `effect-needs-cleanup` cannot follow a listener attached inside a promise).
  const [autocompleteEl, setAutocompleteEl] = useState<HTMLElement | null>(null);
  const onPlaceSelectEvent = useEffectEvent(onPlaceSelect);

  useEffect(() => {
    let cancelled = false;
    let element: HTMLElement | null = null;

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
        /* 16px: anything smaller makes iOS Safari zoom the viewport on focus. */
        gmp-place-autocomplete::part(input) {
          font-size: 1rem;
          line-height: 1.5rem;
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
        if (ariaLabel) {
          element.setAttribute('aria-label', ariaLabel);
        }
        if (ariaLabelledBy) {
          element.setAttribute('aria-labelledby', ariaLabelledBy);
        }
        element.style.width = '100%';


        containerRef.current.replaceChildren();
        containerRef.current.appendChild(element);
        setAutocompleteEl(element);
      })
      .catch((err: unknown) => {
        if (cancelled) return;

        setError('Failed to load Google Maps — use the URL input instead');
        console.error('[PlaceAutocomplete] Load error:', err);
      });

    return () => {
      cancelled = true;
      element?.remove();
      setAutocompleteEl(null);
    };
  }, [ariaLabel, ariaLabelledBy, placeholder]);

  // Subscribe to the element's selection event; unsubscribe on unmount or when
  // the element is replaced.
  useEffect(() => {
    if (!autocompleteEl) return;
    let cancelled = false;
    const handleSelect = async (event: Event) => {
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
        onPlaceSelectEvent(result);
      } catch (err: unknown) {
        if (cancelled) return;

        setError('Failed to load place details');
        console.error('[PlaceAutocomplete]', err);
      }
    };

    autocompleteEl.addEventListener('gmp-select', handleSelect);
    return () => {
      cancelled = true;
      autocompleteEl.removeEventListener('gmp-select', handleSelect);
    };
  }, [autocompleteEl]);

  const handleClear = () => {
    setSelection(null);
    setError(null);
    onClear?.();
  };

  return (
    <div>
      <div ref={containerRef} />

      {error && (
        <p role="alert" className="text-sm text-rw-error mt-1">
          {error}
        </p>
      )}

      {/* Confirmation card: the address is the owner's fact; the check glyph
          is the colour's shape cue. The Place ID is our identifier, not theirs
          — it never renders. */}
      {selection && (
        <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-rw-success/30 bg-rw-success/5 px-4 py-3">
          <p className="flex items-start gap-2 text-sm text-rw-ink">
            <span aria-hidden="true" className="mt-px shrink-0 font-medium text-rw-success">
              ✓
            </span>
            <span>
              <span className="sr-only">Selected: </span>
              {selection.formattedAddress}
            </span>
          </p>
          <button
            type="button"
            onClick={handleClear}
            className="shrink-0 -my-2 min-h-[44px] px-2 text-sm font-medium text-rw-teal-strong hover:text-rw-teal-strong-hover hover:underline"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
