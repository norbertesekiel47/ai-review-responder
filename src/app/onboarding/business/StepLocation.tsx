'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { PlaceAutocomplete } from '@/components/places/PlaceAutocomplete';
import type { WizardFormData } from './BusinessWizardClient';
import { computePrefillPatch } from './prefill-patch';
import type { BusinessSubcategory } from '@/lib/shared/business-categories';
import { StepHeading } from './StepHeading';
import { LazyMotion, m, domAnimation } from 'motion/react';
import {
  fieldClass,
  primaryButtonClass,
  buttonMotion,
} from '../_shared/field-styles';

interface StepLocationProps {
  stepLabel: string;
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
  stepLabel,
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
    // NORMALIZED (#1093): the comparisons in `computePrefillPatch` are against
    // vocabulary members, so the snapshot must be one too.
    category: BusinessSubcategory | null;
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
      // The three prefill modes live in `prefill-patch.ts` as a pure function
      // (#1093): it is the most breakable rule in this step, and as a closure
      // inside this async handler it could only be tested through the component.
      const { patch, nextLastPrefill } = computePrefillPatch({
        prefill,
        data: { category: data.category, website: data.website },
        dirty: dirtyRef.current,
        lastPrefill: lastPrefillRef.current,
      });

      if (Object.keys(patch).length > 0) update(patch);
      lastPrefillRef.current = nextLastPrefill;
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
    <LazyMotion features={domAnimation}>
    <div className="space-y-4">
      <StepHeading stepLabel={stepLabel}>Find your business</StepHeading>
      <p className="text-sm text-rw-ink-soft">
        Search Google Maps for your business or paste its Google Maps URL.
      </p>

      {data.inputMode === 'autocomplete' ? (
        <PlaceAutocomplete
          ariaLabel="Business location"
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
          aria-label="Google Maps URL"
          type="text"
          value={data.googleMapsUrl}
          onChange={(e) => update({ googleMapsUrl: e.target.value })}
          placeholder="https://maps.google.com/..."
          className={fieldClass}
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
        className="text-xs text-rw-teal-strong hover:text-rw-teal-strong-hover underline"
      >
        {data.inputMode === 'autocomplete'
          ? 'Or paste a Google Maps URL'
          : 'Use search instead'}
      </button>

      {prefilling && (
        <p className="text-xs text-rw-warm-gray">
          Fetching business details from Google Maps…
        </p>
      )}

      <div className="flex justify-end pt-4">
        <m.button
          type="button"
          onClick={onNext}
          disabled={!canContinue}
          {...buttonMotion}
          className={primaryButtonClass}
        >
          Continue →
        </m.button>
      </div>
    </div>
    </LazyMotion>
  );
}
