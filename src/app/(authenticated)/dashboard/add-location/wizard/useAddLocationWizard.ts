'use client';

// src/app/(authenticated)/dashboard/add-location/wizard/useAddLocationWizard.ts
//
// Owns all wizard impurity: useReducer + two useQuery data loads (bridged into
// the reducer) + the async submit (POST /api/locations/add → set location scope
// → navigate to the connect flow). Returns a flat state-plus-actions object the
// shell composes from.

import { useCallback, useEffect, useReducer } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { PlaceSelection } from '@/components/PlaceAutocomplete';
import { useLocationScope } from '@/contexts/LocationContext';
import type { LocationId } from '@/lib/shared/ids';
import { computeNextLocationBillingPreview, computeProration } from './billing';
import { buildAddLocationPayload, hasStep1LocationDetails } from './payload';
import { initialState, reducer } from './reducer';
import {
  STEP_INFO,
  type ExistingLocationVoice,
  type Props,
  type VoiceFormState,
} from './types';

// Shape of a single /api/settings/voice location row. Every field beyond the
// two identifiers is optional and normalized to its empty default below.
interface RawVoiceLocation {
  locationId: string;
  displayName: string;
  tone?: string;
  productsServices?: string;
  avoidFacts?: string[];
  sampleResponses?: string[];
}

export function useAddLocationWizard({
  accountId,
  billingSnapshot,
  activeLocationCount,
}: Props) {
  const router = useRouter();
  const { setLocationScope } = useLocationScope();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);

  // Fetch existing location voice configs for the "copy from" dropdown.
  // The query throws on non-OK / network error; the bridging effect below maps
  // both success and failure into the reducer (VOICE_CONFIGS_LOADED / _FAILED)
  // so existingLocations + voiceLoading stay owned solely by the reducer.
  const voiceConfigsQuery = useQuery<ExistingLocationVoice[]>({
    queryKey: ['add-location-wizard', 'voice-configs'],
    queryFn: async () => {
      const res = await fetch('/api/settings/voice');
      if (!res.ok) {
        throw new Error(`Failed to load voice configs (${res.status})`);
      }
      const json: { locations?: RawVoiceLocation[] } = await res.json();
      return (json.locations ?? []).map((loc) => ({
        locationId: loc.locationId,
        displayName: loc.displayName,
        tone: loc.tone ?? '',
        productsServices: loc.productsServices ?? '',
        avoidFacts: loc.avoidFacts ?? [],
        sampleResponses: loc.sampleResponses ?? [],
      }));
    },
  });

  useEffect(() => {
    if (voiceConfigsQuery.data) {
      dispatch({ type: 'VOICE_CONFIGS_LOADED', locations: voiceConfigsQuery.data });
    } else if (voiceConfigsQuery.isError) {
      // Non-critical — "copy from" dropdown just won't populate.
      dispatch({ type: 'VOICE_CONFIGS_FAILED' });
    }
  }, [voiceConfigsQuery.data, voiceConfigsQuery.isError]);

  // Fetch existing Place IDs for the duplicate check. Non-critical — a failure
  // just leaves the client-side duplicate check empty (the reducer keeps its
  // initial empty Set), so the error branch dispatches nothing.
  const existingPlaceIdsQuery = useQuery<string[]>({
    queryKey: ['add-location-wizard', 'existing-place-ids'],
    queryFn: async () => {
      const res = await fetch('/api/locations/existing-place-ids');
      if (!res.ok) {
        throw new Error(`Failed to load existing place ids (${res.status})`);
      }
      const json: { placeIds?: string[] } = await res.json();
      return json.placeIds ?? [];
    },
  });

  useEffect(() => {
    if (existingPlaceIdsQuery.data !== undefined) {
      dispatch({ type: 'PLACE_IDS_LOADED', placeIds: existingPlaceIdsQuery.data });
    }
  }, [existingPlaceIdsQuery.data]);

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
        dispatch({
          type: 'SUBMIT_FAILED',
          message: body.error ?? body.detail ?? `Failed to add location (${res.status})`,
        });
        return;
      }

      const result = await res.json();

      // Set the newly created location as the active scope.
      // VAL-SETTINGS-047: cookie set with SameSite=Lax, path=/.
      if (result.businessId) {
        setLocationScope(result.businessId as LocationId);
      }

      // Navigate straight to the scoped connect flow for the new location.
      const connectHref = result.businessId
        ? `/dashboard/connect?locationId=${encodeURIComponent(result.businessId)}`
        : '/dashboard/connect';
      router.push(connectHref);
      router.refresh();
    } catch {
      dispatch({ type: 'SUBMIT_FAILED', message: 'Network error — please try again.' });
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
