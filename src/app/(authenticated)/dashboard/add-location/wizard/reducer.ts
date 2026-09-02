// src/app/(authenticated)/dashboard/add-location/wizard/reducer.ts
//
// Pure state machine for the Add-location wizard. Every synchronous
// transition that used to be an inline useState setter lives here; the
// useAddLocationWizard hook owns side effects (fetch, submit, navigation)
// and dispatches these actions.
//
// Transitions are grouped by the wizard step they serve (location, navigation,
// voice, submit) and joined into one exhaustive handler map, so `reducer` is a
// single lookup and each transition reads on its own.

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

type LocationStepAction =
  | { type: 'SET_DISPLAY_LABEL'; value: string }
  | { type: 'SELECT_PLACE'; selection: PlaceSelection }
  | { type: 'CLEAR_PLACE' }
  | { type: 'SET_MAPS_URL'; value: string }
  | { type: 'TOGGLE_INPUT_MODE' }
  | { type: 'PLACE_IDS_LOADED'; placeIds: string[] };

type NavigationAction = { type: 'GO_NEXT' } | { type: 'GO_BACK' };

type VoiceStepAction =
  | { type: 'SET_VOICE_FIELD'; key: keyof VoiceFormState; value: VoiceFormState[keyof VoiceFormState] }
  | { type: 'COPY_FROM_EXISTING'; locationId: string }
  | { type: 'USE_DEFAULT_VOICE' }
  | { type: 'VOICE_CONFIGS_LOADED'; locations: ExistingLocationVoice[] }
  | { type: 'VOICE_CONFIGS_FAILED' };

type SubmitAction =
  | { type: 'SUBMIT_STARTED' }
  | { type: 'SUBMIT_SUCCEEDED'; connectHref: string }
  | { type: 'SUBMIT_FAILED'; message: string };

export type WizardAction = LocationStepAction | NavigationAction | VoiceStepAction | SubmitAction;

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

/** One transition per action type in `A`, exhaustive by construction. */
type Handlers<A extends WizardAction> = {
  [K in A['type']]: (state: WizardState, action: Extract<A, { type: K }>) => WizardState;
};

function nextStep(step: WizardStep): WizardStep {
  return Math.min(step + 1, 4) as WizardStep;
}

function previousStep(step: WizardStep): WizardStep {
  return Math.max(step - 1, 1) as WizardStep;
}

// ── Step 1: location details ────────────────────────────────────────────────

const locationStepHandlers: Handlers<LocationStepAction> = {
  SET_DISPLAY_LABEL: (state, action) => ({
    ...state,
    displayLabel: action.value,
    displayLabelError: null,
  }),

  SELECT_PLACE: (state, action) => {
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
  },

  CLEAR_PLACE: (state) => ({ ...state, placeSelection: null }),

  SET_MAPS_URL: (state, action) => ({ ...state, googleMapsUrl: action.value }),

  TOGGLE_INPUT_MODE: (state) => {
    if (state.inputMode === 'autocomplete') {
      return { ...state, placeIdDuplicateError: null, placeSelection: null, inputMode: 'url' };
    }
    return { ...state, placeIdDuplicateError: null, googleMapsUrl: '', inputMode: 'autocomplete' };
  },

  PLACE_IDS_LOADED: (state, action) => ({ ...state, existingPlaceIds: new Set(action.placeIds) }),
};

// ── Navigation ──────────────────────────────────────────────────────────────

const navigationHandlers: Handlers<NavigationAction> = {
  GO_NEXT: (state) => {
    if (state.step !== 1) return { ...state, step: nextStep(state.step) };
    const v = validateStep1(state);
    const errors = {
      displayLabelError: v.displayLabelError,
      placeIdDuplicateError: v.placeIdDuplicateError,
    };
    if (!v.ok) return { ...state, ...errors };
    return { ...state, ...errors, step: nextStep(state.step) };
  },

  GO_BACK: (state) => ({ ...state, step: previousStep(state.step) }),
};

// ── Step 3: voice ───────────────────────────────────────────────────────────

const voiceStepHandlers: Handlers<VoiceStepAction> = {
  SET_VOICE_FIELD: (state, action) => ({
    ...state,
    // key ∈ keyof VoiceFormState and value matches that key by construction
    // at the dispatch site (the hook's generic setVoiceField setter).
    voiceForm: { ...state.voiceForm, [action.key]: action.value } as VoiceFormState,
    copyFromLocationId: '',
  }),

  // "Use the default voice" on step 3 (UX audit D23). It used to be a plain
  // GO_NEXT, so an owner who had typed half a voice config and then clicked
  // it shipped the half — the button said one thing and did another. It now
  // RESETS the form to DEFAULT_VOICE before advancing.
  USE_DEFAULT_VOICE: (state) => ({
    ...state,
    voiceForm: { ...DEFAULT_VOICE },
    copyFromLocationId: '',
    step: nextStep(state.step),
  }),

  COPY_FROM_EXISTING: (state, action) => {
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
  },

  VOICE_CONFIGS_LOADED: (state, action) => ({
    ...state,
    existingLocations: action.locations,
    voiceLoading: false,
  }),

  VOICE_CONFIGS_FAILED: (state) => ({ ...state, voiceLoading: false }),
};

// ── Step 4: submit lifecycle ────────────────────────────────────────────────

const submitHandlers: Handlers<SubmitAction> = {
  SUBMIT_STARTED: (state) => ({
    ...state,
    submitPhase: 'submitting',
    submitError: null,
    connectHref: null,
  }),

  SUBMIT_SUCCEEDED: (state, action) => ({
    ...state,
    submitPhase: 'succeeded',
    submitError: null,
    connectHref: action.connectHref,
  }),

  SUBMIT_FAILED: (state, action) => ({
    ...state,
    submitPhase: 'failed',
    submitError: action.message,
  }),
};

const HANDLERS: Handlers<WizardAction> = {
  ...locationStepHandlers,
  ...navigationHandlers,
  ...voiceStepHandlers,
  ...submitHandlers,
};

export function reducer(state: WizardState, action: WizardAction): WizardState {
  // The map is exhaustive over `WizardAction['type']` (checked by `Handlers`),
  // so the lookup cannot miss; the cast only re-widens the per-key action
  // parameter the mapped type narrowed.
  const handle = HANDLERS[action.type] as (s: WizardState, a: WizardAction) => WizardState;
  return handle(state, action);
}
