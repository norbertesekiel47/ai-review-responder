'use client';

// src/app/(authenticated)/dashboard/add-location/wizard/useAddLocationWizard.ts
//
// Owns all wizard impurity: useReducer + two fetch effects + the async submit
// (POST /api/locations/add → set location scope → navigate to the connect
// flow). Returns a flat state-plus-actions object the shell composes from.

import { useCallback, useEffect, useReducer } from 'react';
import { useRouter } from 'next/navigation';
import type { PlaceSelection } from '@/components/places/PlaceAutocomplete';
import { useLocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';
import { computeNextLocationBillingPreview, computeProration } from './billing';
import { buildAddLocationPayload, hasStep1LocationDetails } from './payload';
import { initialState, reducer } from './reducer';
import { ownerFacingLocationError } from '@/lib/locations/duplicate-location';

/** Owner-facing message for an add-location submit failure. */
function submitErrorMessage(body: { error?: string; detail?: string }, status: number): string {
  return ownerFacingLocationError(
    body.error,
    body.detail ?? `Failed to add location (${status})`,
  );
}

import {
  STEP_INFO,
  type ExistingLocationVoice,
  type Props,
  type VoiceConfigApiLocation,
  type VoiceFormState,
} from './types';

export function useAddLocationWizard({
  accountId,
  billingSnapshot,
  activeLocationCount,
}: Props) {
  const router = useRouter();
  const { setLocationScope } = useLocationScope();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // Fetch existing location voice configs for the "copy from" dropdown.
  useEffect(() => {
    let cancelled = false;

    async function fetchVoiceConfigs() {
      try {
        const res = await fetch('/api/settings/voice');
        if (!res.ok) {
          if (!cancelled) dispatch({ type: 'VOICE_CONFIGS_FAILED' });
          return;
        }
        const json = await res.json();
        if (cancelled) return;

        const locs: ExistingLocationVoice[] = (json.locations ?? []).map(
          (loc: VoiceConfigApiLocation) => ({
            locationId: loc.locationId,
            displayName: loc.displayName,
            tone: loc.tone ?? '',
            productsServices: loc.productsServices ?? '',
            avoidFacts: loc.avoidFacts ?? [],
            sampleResponses: loc.sampleResponses ?? [],
          }),
        );
        dispatch({ type: 'VOICE_CONFIGS_LOADED', locations: locs });
      } catch {
        // Non-critical — "copy from" dropdown just won't populate.
        if (!cancelled) dispatch({ type: 'VOICE_CONFIGS_FAILED' });
      }
    }

    fetchVoiceConfigs();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch existing Place IDs for the duplicate check.
  useEffect(() => {
    let cancelled = false;

    async function fetchExisting() {
      try {
        const res = await fetch('/api/locations/existing-place-ids');
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        if (json.placeIds) {
          dispatch({ type: 'PLACE_IDS_LOADED', placeIds: json.placeIds });
        }
      } catch {
        // Non-critical — duplicate check just won't be client-side.
      }
    }

    fetchExisting();
    return () => {
      cancelled = true;
    };
  }, []);

  const goNext = useCallback(() => dispatch({ type: 'GO_NEXT' }), []);
  const goBack = useCallback(() => dispatch({ type: 'GO_BACK' }), []);
  const selectPlace = useCallback(
    (selection: PlaceSelection) => dispatch({ type: 'SELECT_PLACE', selection }),
    [],
  );
  const clearPlace = useCallback(() => dispatch({ type: 'CLEAR_PLACE' }), []);
  const setDisplayLabel = useCallback(
    (value: string) => dispatch({ type: 'SET_DISPLAY_LABEL', value }),
    [],
  );
  const setMapsUrl = useCallback(
    (value: string) => dispatch({ type: 'SET_MAPS_URL', value }),
    [],
  );
  const toggleInputMode = useCallback(() => dispatch({ type: 'TOGGLE_INPUT_MODE' }), []);
  const setVoiceField = useCallback(
    <K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) =>
      dispatch({ type: 'SET_VOICE_FIELD', key, value }),
    [],
  );
  const copyFromExisting = useCallback(
    (locationId: string) => dispatch({ type: 'COPY_FROM_EXISTING', locationId }),
    [],
  );

  const handleSubmit = useCallback(async () => {
    dispatch({ type: 'SUBMIT_STARTED' });

    let businessId: string | null;
    try {
      const res = await fetch('/api/locations/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildAddLocationPayload({
            accountId,
            displayLabel: state.displayLabel,
            inputMode: state.inputMode,
            placeSelection: state.placeSelection,
            // Helper omits unused optional fields so the API receives either
            // a verified Place ID or a manual Google Maps URL.
            googleMapsUrl: state.googleMapsUrl,
            voiceForm: state.voiceForm,
          }),
        ),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // VAL-LOC-064: show inline error, stay on step 4.
        dispatch({ type: 'SUBMIT_FAILED', message: submitErrorMessage(body, res.status) });
        return;
      }

      const result = await res.json();
      businessId = typeof result.businessId === 'string' ? result.businessId : null;
    } catch {
      dispatch({ type: 'SUBMIT_FAILED', message: 'Network error — please try again.' });
      return;
    }

    // The location exists from here on, so nothing below may re-open the
    // loading state or invite a retry. #781: settle into the terminal
    // `succeeded` phase BEFORE touching the router — navigation is the last
    // thing that happens, never the thing that ends the spinner.
    const connectHref = businessId
      ? `/dashboard/connect?locationId=${encodeURIComponent(businessId)}`
      : '/dashboard/connect';
    dispatch({ type: 'SUBMIT_SUCCEEDED', connectHref });

    try {
      // Set the newly created location as the active scope.
      // VAL-SETTINGS-047: cookie set with SameSite=Lax, path=/.
      if (businessId) {
        setLocationScope(businessId as LocationId);
      }

      // Navigate straight to the scoped connect flow for the new location.
      // Nothing may follow this push. #781: setLocationScope already calls
      // router.refresh(), and a second refresh issued after the push
      // supersedes the in-flight navigation — the add succeeded and the owner
      // went nowhere.
      router.push(connectHref);
    } catch (err) {
      // Not swallowed: step 4 is already showing the terminal "location added"
      // notice with a manual link to `connectHref`, so the owner has a way
      // forward. Logged for diagnostics rather than surfaced as a retry.
      console.error('[add-location] navigation after a successful add failed:', err);
    }
  }, [
    accountId,
    state.displayLabel,
    state.inputMode,
    state.placeSelection,
    state.googleMapsUrl,
    state.voiceForm,
    router,
    setLocationScope,
  ]);

  const billingPreview = computeNextLocationBillingPreview({
    activeLocationCount,
    billingSnapshot,
  });
  const proration = computeProration(billingPreview.additionalLocationMonthlyCents);
  const step1HasLocationDetails = hasStep1LocationDetails({
    inputMode: state.inputMode,
    placeSelection: state.placeSelection,
    googleMapsUrl: state.googleMapsUrl,
  });
  const stepInfo = STEP_INFO[state.step];

  return {
    ...state,
    // Derived from the phase so the components keep a flat boolean contract.
    submitting: state.submitPhase === 'submitting',
    submitted: state.submitPhase === 'succeeded',
    billingPreview,
    proration,
    newMonthlyTotalCents: billingPreview.newMonthlyTotalCents,
    step1HasLocationDetails,
    stepInfo,
    goNext,
    goBack,
    selectPlace,
    clearPlace,
    setDisplayLabel,
    setMapsUrl,
    toggleInputMode,
    setVoiceField,
    copyFromExisting,
    handleSubmit,
  };
}
