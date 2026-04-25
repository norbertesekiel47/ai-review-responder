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

  // Cancel any in-flight prefill fetch when the step unmounts so a stale
  // response can't repopulate fields after the user has navigated away.
  useEffect(() => {
    return () => {
      if (prefillAbortRef.current) prefillAbortRef.current.abort();
    };
  }, []);

  function cancelPrefill() {
    latestPlaceIdRef.current = null;
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

      const patch: Partial<WizardFormData> = {};
      if (prefill.category && !dirtyRef.current?.category && !data.category) {
        patch.category = prefill.category;
      }
      if (prefill.website && !dirtyRef.current?.website && !data.website) {
        patch.website = prefill.website;
      }
      if (Object.keys(patch).length > 0) update(patch);
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
