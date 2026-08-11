// src/app/(authenticated)/dashboard/add-location/wizard/reducer.ts
//
// Pure state machine for the Add-location wizard. Every synchronous
// transition that used to be an inline useState setter lives here; the
// useAddLocationWizard hook owns side effects (fetch, submit, navigation)
// and dispatches these actions.

import type { PlaceSelection } from '@/components/places/PlaceAutocomplete';
import {
  DEFAULT_VOICE,
  type ExistingLocationVoice,
  type LocationInputMode,
  type VoiceFormState,
  type WizardStep,
} from './types';
import { hasStep1LocationDetails } from './payload';

/**
 * Lifecycle of the step-4 submit. `succeeded` and `failed` are both TERMINAL:
 * the wizard reaches one of them from the fetch result alone, never from a
 * navigation side effect. Before #781 there was no success phase at all, so
 * the only exit from the loading state was navigating away — which made a
 * navigation that never landed an unbounded spinner over an add that had in
 * fact worked.
 */
export type SubmitPhase = 'idle' | 'submitting' | 'succeeded' | 'failed';

export interface WizardState {
  step: WizardStep;
  inputMode: LocationInputMode;
  placeSelection: PlaceSelection | null;
  googleMapsUrl: string;
  displayLabel: string;
  displayLabelError: string | null;
  placeIdDuplicateError: string | null;
  voiceForm: VoiceFormState;
  existingLocations: ExistingLocationVoice[];
  copyFromLocationId: string;
  voiceLoading: boolean;
  submitPhase: SubmitPhase;
  submitError: string | null;
  /** Set on SUBMIT_SUCCEEDED — the connect-flow route for the created
   * location, so step 4 can offer a manual link if the redirect never lands. */
  connectHref: string | null;
  existingPlaceIds: Set<string>;
}

export type WizardAction =
  | { type: 'SET_DISPLAY_LABEL'; value: string }
  | { type: 'SELECT_PLACE'; selection: PlaceSelection }
  | { type: 'CLEAR_PLACE' }
  | { type: 'SET_MAPS_URL'; value: string }
  | { type: 'TOGGLE_INPUT_MODE' }
  | { type: 'GO_NEXT' }
  | { type: 'GO_BACK' }
  | { type: 'SET_VOICE_FIELD'; key: keyof VoiceFormState; value: VoiceFormState[keyof VoiceFormState] }
  | { type: 'COPY_FROM_EXISTING'; locationId: string }
  | { type: 'VOICE_CONFIGS_LOADED'; locations: ExistingLocationVoice[] }
  | { type: 'VOICE_CONFIGS_FAILED' }
  | { type: 'PLACE_IDS_LOADED'; placeIds: string[] }
  | { type: 'SUBMIT_STARTED' }
  | { type: 'SUBMIT_SUCCEEDED'; connectHref: string }
  | { type: 'SUBMIT_FAILED'; message: string };

export function initialState(): WizardState {
  return {
    step: 1,
    inputMode: 'autocomplete',
    placeSelection: null,
    googleMapsUrl: '',
    displayLabel: '',
    displayLabelError: null,
    placeIdDuplicateError: null,
    voiceForm: { ...DEFAULT_VOICE },
    existingLocations: [],
    copyFromLocationId: '',
    voiceLoading: true,
    submitPhase: 'idle',
    submitError: null,
    connectHref: null,
    existingPlaceIds: new Set<string>(),
  };
}

interface Step1Validation {
  ok: boolean;
  displayLabelError: string | null;
  placeIdDuplicateError: string | null;
}

// Mirrors the original validateStep1 callback. Returns the error fields to
// apply (clearing on pass) plus whether navigation may proceed.
// VAL-SETTINGS-043 (label) and VAL-SETTINGS-044 (duplicate Place ID).
function validateStep1(state: WizardState): Step1Validation {
  const trimmed = state.displayLabel.trim();
  if (!trimmed) {
    return {
      ok: false,
      displayLabelError: 'Location name is required',
      placeIdDuplicateError: state.placeIdDuplicateError,
    };
  }
  if (trimmed.length > 255) {
    return {
      ok: false,
      displayLabelError: 'Location name must be 255 characters or less',
      placeIdDuplicateError: state.placeIdDuplicateError,
    };
  }
  if (
    !hasStep1LocationDetails({
      inputMode: state.inputMode,
      placeSelection: state.placeSelection,
      googleMapsUrl: state.googleMapsUrl,
    })
  ) {
    // No explicit error — the autocomplete UI makes this clear.
    return { ok: false, displayLabelError: null, placeIdDuplicateError: state.placeIdDuplicateError };
  }
  if (
    state.inputMode === 'autocomplete' &&
    state.placeSelection?.placeId &&
    state.existingPlaceIds.has(state.placeSelection.placeId)
  ) {
    return { ok: false, displayLabelError: null, placeIdDuplicateError: 'This location is already added' };
  }
  return { ok: true, displayLabelError: null, placeIdDuplicateError: null };
}

export function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'SET_DISPLAY_LABEL':
      return { ...state, displayLabel: action.value, displayLabelError: null };

    case 'SELECT_PLACE': {
      const next: WizardState = {
        ...state,
        placeSelection: action.selection,
        googleMapsUrl: '',
        placeIdDuplicateError: null,
      };
      if (!state.displayLabel.trim()) {
        const shortName = action.selection.formattedAddress.split(',')[0]?.trim() ?? '';
        return { ...next, displayLabel: shortName };
      }
      return next;
    }

    case 'CLEAR_PLACE':
      return { ...state, placeSelection: null };

    case 'SET_MAPS_URL':
      return { ...state, googleMapsUrl: action.value };

    case 'TOGGLE_INPUT_MODE':
      if (state.inputMode === 'autocomplete') {
        return { ...state, placeIdDuplicateError: null, placeSelection: null, inputMode: 'url' };
      }
      return { ...state, placeIdDuplicateError: null, googleMapsUrl: '', inputMode: 'autocomplete' };

    case 'GO_NEXT': {
      if (state.step === 1) {
        const v = validateStep1(state);
        const errors = {
          displayLabelError: v.displayLabelError,
          placeIdDuplicateError: v.placeIdDuplicateError,
        };
        if (!v.ok) return { ...state, ...errors };
        return { ...state, ...errors, step: Math.min(state.step + 1, 4) as WizardStep };
      }
      return { ...state, step: Math.min(state.step + 1, 4) as WizardStep };
    }

    case 'GO_BACK':
      return { ...state, step: Math.max(state.step - 1, 1) as WizardStep };

    case 'SET_VOICE_FIELD':
      return {
        ...state,
        // key ∈ keyof VoiceFormState and value matches that key by construction
        // at the dispatch site (the hook's generic setVoiceField setter).
        voiceForm: { ...state.voiceForm, [action.key]: action.value } as VoiceFormState,
        copyFromLocationId: '',
      };

    case 'COPY_FROM_EXISTING': {
      const next = { ...state, copyFromLocationId: action.locationId };
      if (!action.locationId) return next;
      const source = state.existingLocations.find((l) => l.locationId === action.locationId);
      if (!source) return next;
      return {
        ...next,
        voiceForm: {
          tone: source.tone,
          productsServices: source.productsServices,
          avoidFacts: source.avoidFacts.slice(),
          sampleResponses: source.sampleResponses.slice(),
        },
      };
    }

    case 'VOICE_CONFIGS_LOADED':
      return { ...state, existingLocations: action.locations, voiceLoading: false };

    case 'VOICE_CONFIGS_FAILED':
      return { ...state, voiceLoading: false };

    case 'PLACE_IDS_LOADED':
      return { ...state, existingPlaceIds: new Set(action.placeIds) };

    case 'SUBMIT_STARTED':
      return { ...state, submitPhase: 'submitting', submitError: null, connectHref: null };

    case 'SUBMIT_SUCCEEDED':
      return {
        ...state,
        submitPhase: 'succeeded',
        submitError: null,
        connectHref: action.connectHref,
      };

    case 'SUBMIT_FAILED':
      return { ...state, submitPhase: 'failed', submitError: action.message };

    default:
      return state;
  }
}
