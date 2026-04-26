'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { PlaceAutocomplete } from '@/components/PlaceAutocomplete';
import type { WizardFormData } from './BusinessWizardClient';

interface StepLocationProps {
  data: WizardFormData;
  update: (patch: Partial<WizardFormData>) => void;
  dirtyRef: RefObject<{ category: boolean; website: boolean }>;
  onNext: () => void;
}

interface PrefillResponse {
  category: string | null;
  phone: string | null;
  website: string | null;
  hours: string | null;
  fullAddress: string | null;
}

export function StepLocation({
  data,
  update,
  dirtyRef,
  onNext,
}: StepLocationProps) {
  const [prefilling, setPrefilling] = useState(false);
  const prefillAbortRef = useRef<AbortController | null>(null);
  const latestPlaceIdRef = useRef<string | null>(null);
  // Track the last prefill values we actually applied per field. Without
  // this, re-selecting a different place while category/website still hold
  // the previous place's prefilled value would silently drop the new
  // prefill (the `!data.X` guard treats already-populated fields as
  // "user-owned"). With it, an unedited prefilled value is allowed to be
  // overwritten by a later prefill of a different place — but a value the
  // user typed/edited stays put because dirtyRef.current.X locks it.
  const lastPrefillRef = useRef<{
    category: string | null;
    website: string | null;
  }>({ category: null, website: null });

  // Cancel any in-flight prefill fetch when the step unmounts so a stale
  // response can't repopulate fields after the user has navigated away.
  useEffect(() => {
    return () => {
      if (prefillAbortRef.current) prefillAbortRef.current.abort();
    };
  }, []);

  function cancelPrefill() {
    latestPlaceIdRef.current = null;
    // Reset the prefill snapshot too — a clear means "forget what was
    // applied", so the next place's prefill should fire as a first-pick
    // (compares against null → falls into the !data.X branch).
    lastPrefillRef.current = { category: null, website: null };
    if (prefillAbortRef.current) {
      prefillAbortRef.current.abort();
      prefillAbortRef.current = null;
    }
    setPrefilling(false);
  }

  async function triggerPrefill(placeId: string) {
    if (prefillAbortRef.current) prefillAbortRef.current.abort();
    const controller = new AbortController();
    prefillAbortRef.current = controller;
    latestPlaceIdRef.current = placeId;

    setPrefilling(true);
    try {
      const res = await fetch(
        `/api/signup/place-prefill?place_id=${encodeURIComponent(placeId)}`,
        { signal: controller.signal },
      );
      if (latestPlaceIdRef.current !== placeId) return;
      if (!res.ok) return;
      const prefill = (await res.json()) as PrefillResponse;
      if (latestPlaceIdRef.current !== placeId) return;

      // Apply prefill in three modes (per field):
      //   (a) value present + first-pick (data.X empty) → set it
      //   (b) value present + re-pick of a DIFFERENT place (lastPrefill differs) → overwrite
      //   (c) value EXPLICITLY null + previous prefill DID set the field → CLEAR it
      // Without (c), picking Place A (category='Cafe') and then re-picking
      // Place B (category=null) would leave the form showing 'Cafe' even
      // though Place B has no category info — stale prefill data masquerading
      // as "what Place B says". The dirty flag still wins in all three modes:
      // a value the user typed/edited is never overwritten or cleared.
      const patch: Partial<WizardFormData> = {};

      // category
      if (!dirtyRef.current?.category) {
        if (
          prefill.category &&
          (!data.category || prefill.category !== lastPrefillRef.current.category)
        ) {
          patch.category = prefill.category;
        } else if (
          prefill.category === null &&
          lastPrefillRef.current.category !== null &&
          data.category
        ) {
          // Previous prefill set the value, this prefill returned null, user
          // hasn't edited → the value belongs to the OLD place. Clear it.
          // Use empty string (not null/undefined) to match the WizardFormData
          // shape and avoid React warning about controlled-input value.
          patch.category = '';
        }
      }

      // website
      if (!dirtyRef.current?.website) {
        if (
          prefill.website &&
          (!data.website || prefill.website !== lastPrefillRef.current.website)
        ) {
          patch.website = prefill.website;
        } else if (
          prefill.website === null &&
          lastPrefillRef.current.website !== null &&
          data.website
        ) {
          patch.website = '';
        }
      }

      if (Object.keys(patch).length > 0) update(patch);
      // Always update the snapshot (even when patch is empty) so the next
      // re-pick compares against the latest known prefill values. Use the
      // PREFILL response, not patch — `data.X` may have been kept by the
      // dirty flag, but the prefill value still represents what THIS place
      // would have set.
      lastPrefillRef.current = {
        category: prefill.category,
        website: prefill.website,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    } finally {
      if (prefillAbortRef.current === controller) {
        setPrefilling(false);
        prefillAbortRef.current = null;
      }
    }
  }

  const canContinue =
    data.inputMode === 'autocomplete'
      ? Boolean(data.googlePlaceId)
      : Boolean(data.googleMapsUrl.trim());

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
      <h2 className="text-lg font-medium text-gray-900">Find your business</h2>
      <p className="text-sm text-gray-600">
        Search Google Maps for your business or paste its Google Maps URL.
      </p>

      {data.inputMode === 'autocomplete' ? (
        <PlaceAutocomplete
          onPlaceSelect={(sel) => {
            update({
              googlePlaceId: sel.placeId,
              googlePlaceAddress: sel.formattedAddress,
            });
            triggerPrefill(sel.placeId);
          }}
          onClear={() => {
            cancelPrefill();
            update({ googlePlaceId: '', googlePlaceAddress: '' });
            // Reset prefill-derived fields if untouched so a subsequent
            // place selection can refill them. Mirrors the admin form's
            // resetField pattern.
            const reset: Partial<WizardFormData> = {};
            if (!dirtyRef.current?.category) reset.category = '';
            if (!dirtyRef.current?.website) reset.website = '';
            if (Object.keys(reset).length > 0) update(reset);
          }}
        />
      ) : (
        <input
          type="text"
          value={data.googleMapsUrl}
          onChange={(e) => update({ googleMapsUrl: e.target.value })}
          placeholder="https://maps.google.com/..."
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          autoComplete="url"
        />
      )}

      <button
        type="button"
        onClick={() => {
          if (data.inputMode === 'autocomplete') {
            cancelPrefill();
            update({
              inputMode: 'url',
              googlePlaceId: '',
              googlePlaceAddress: '',
            });
          } else {
            update({ inputMode: 'autocomplete', googleMapsUrl: '' });
          }
        }}
        className="text-xs text-blue-600 hover:text-blue-800"
      >
        {data.inputMode === 'autocomplete'
          ? 'Or paste a Google Maps URL'
          : 'Use search instead'}
      </button>

      {prefilling && (
        <p className="text-xs text-gray-500">
          Fetching business details from Google Maps…
        </p>
      )}

      <div className="flex justify-end pt-4">
        <button
          type="button"
          onClick={onNext}
          disabled={!canContinue}
          className="bg-blue-600 text-white font-medium py-2 px-6 rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          Continue →
        </button>
      </div>
    </div>
  );
}
