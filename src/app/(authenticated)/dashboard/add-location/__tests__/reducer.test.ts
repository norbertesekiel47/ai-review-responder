// src/app/(authenticated)/dashboard/add-location/__tests__/reducer.test.ts
//
// Characterization suite for the Add-location wizard reducer. Captures the
// exact synchronous transitions previously implemented as inline useState
// setters in AddLocationWizard.tsx.

import { describe, it, expect } from 'vitest';
import { initialState, reducer, type WizardState } from '../wizard/reducer';
import type { PlaceSelection } from '@/components/places/PlaceAutocomplete';
import type { ExistingLocationVoice } from '../wizard/types';

const PLACE: PlaceSelection = {
  placeId: 'place_abc',
  formattedAddress: 'Downtown Cafe, 123 Main St, Springfield',
  lat: 0,
  lng: 0,
};

const SOURCE_LOC: ExistingLocationVoice = {
  locationId: 'loc-1',
  displayName: 'Uptown',
  tone: 'warm',
  productsServices: 'coffee',
  avoidFacts: ['no discounts'],
  sampleResponses: ['thanks!'],
};

function withState(overrides: Partial<WizardState>): WizardState {
  return { ...initialState(), ...overrides };
}

describe('initialState', () => {
  it('starts on step 1, autocomplete mode, voice loading', () => {
    const s = initialState();
    expect(s.step).toBe(1);
    expect(s.inputMode).toBe('autocomplete');
    expect(s.voiceLoading).toBe(true);
    expect(s.placeSelection).toBeNull();
    expect(s.existingPlaceIds.size).toBe(0);
    expect(s.voiceForm).toEqual({
      tone: 'professional and friendly',
      productsServices: '',
      avoidFacts: [],
      sampleResponses: [],
    });
  });
});

describe('SET_DISPLAY_LABEL', () => {
  it('sets the label and clears any label error', () => {
    const s = reducer(
      withState({ displayLabelError: 'Location name is required' }),
      { type: 'SET_DISPLAY_LABEL', value: 'Cafe' },
    );
    expect(s.displayLabel).toBe('Cafe');
    expect(s.displayLabelError).toBeNull();
  });
});

describe('SELECT_PLACE', () => {
  it('stores the selection and clears URL + duplicate error', () => {
    const s = reducer(
      withState({ googleMapsUrl: 'x', placeIdDuplicateError: 'dup' }),
      { type: 'SELECT_PLACE', selection: PLACE },
    );
    expect(s.placeSelection).toEqual(PLACE);
    expect(s.googleMapsUrl).toBe('');
    expect(s.placeIdDuplicateError).toBeNull();
  });

  it('auto-fills display label from the first address segment when empty', () => {
    const s = reducer(withState({ displayLabel: '' }), {
      type: 'SELECT_PLACE',
      selection: PLACE,
    });
    expect(s.displayLabel).toBe('Downtown Cafe');
  });

  it('does not overwrite a non-empty display label', () => {
    const s = reducer(withState({ displayLabel: 'My Cafe' }), {
      type: 'SELECT_PLACE',
      selection: PLACE,
    });
    expect(s.displayLabel).toBe('My Cafe');
  });
});

describe('CLEAR_PLACE', () => {
  it('clears the selection', () => {
    const s = reducer(withState({ placeSelection: PLACE }), { type: 'CLEAR_PLACE' });
    expect(s.placeSelection).toBeNull();
  });
});

describe('SET_MAPS_URL', () => {
  it('sets the maps URL', () => {
    const s = reducer(initialState(), {
      type: 'SET_MAPS_URL',
      value: 'https://maps.google.com/x',
    });
    expect(s.googleMapsUrl).toBe('https://maps.google.com/x');
  });
});

describe('TOGGLE_INPUT_MODE', () => {
  it('autocomplete → url clears the selection and dup error', () => {
    const s = reducer(
      withState({ inputMode: 'autocomplete', placeSelection: PLACE, placeIdDuplicateError: 'dup' }),
      { type: 'TOGGLE_INPUT_MODE' },
    );
    expect(s.inputMode).toBe('url');
    expect(s.placeSelection).toBeNull();
    expect(s.placeIdDuplicateError).toBeNull();
  });

  it('url → autocomplete clears the typed URL', () => {
    const s = reducer(
      withState({ inputMode: 'url', googleMapsUrl: 'https://x' }),
      { type: 'TOGGLE_INPUT_MODE' },
    );
    expect(s.inputMode).toBe('autocomplete');
    expect(s.googleMapsUrl).toBe('');
  });
});

describe('GO_NEXT — step 1 validation', () => {
  it('blocks with an error when the label is empty', () => {
    const s = reducer(withState({ step: 1, displayLabel: '   ' }), { type: 'GO_NEXT' });
    expect(s.step).toBe(1);
    expect(s.displayLabelError).toBe('Location name is required');
  });

  it('blocks with an error when the label exceeds 255 chars', () => {
    const s = reducer(withState({ step: 1, displayLabel: 'A'.repeat(256) }), { type: 'GO_NEXT' });
    expect(s.step).toBe(1);
    expect(s.displayLabelError).toBe('Location name must be 255 characters or less');
  });

  it('blocks without an explicit error when no location details are provided', () => {
    const s = reducer(
      withState({ step: 1, displayLabel: 'Cafe', inputMode: 'autocomplete', placeSelection: null }),
      { type: 'GO_NEXT' },
    );
    expect(s.step).toBe(1);
    expect(s.displayLabelError).toBeNull();
  });

  it('blocks with a duplicate error when the Place ID already exists', () => {
    const s = reducer(
      withState({
        step: 1,
        displayLabel: 'Cafe',
        inputMode: 'autocomplete',
        placeSelection: PLACE,
        existingPlaceIds: new Set(['place_abc']),
      }),
      { type: 'GO_NEXT' },
    );
    expect(s.step).toBe(1);
    expect(s.placeIdDuplicateError).toBe('This location is already added');
  });

  it('advances to step 2 and clears errors when step 1 is valid (autocomplete)', () => {
    const s = reducer(
      withState({
        step: 1,
        displayLabel: 'Cafe',
        inputMode: 'autocomplete',
        placeSelection: PLACE,
        existingPlaceIds: new Set(['other']),
      }),
      { type: 'GO_NEXT' },
    );
    expect(s.step).toBe(2);
    expect(s.displayLabelError).toBeNull();
    expect(s.placeIdDuplicateError).toBeNull();
  });

  it('advances with a manual Maps URL', () => {
    const s = reducer(
      withState({ step: 1, displayLabel: 'Cafe', inputMode: 'url', googleMapsUrl: 'https://maps.google.com/x' }),
      { type: 'GO_NEXT' },
    );
    expect(s.step).toBe(2);
  });

  it('does not advance past step 4', () => {
    const s = reducer(withState({ step: 4 }), { type: 'GO_NEXT' });
    expect(s.step).toBe(4);
  });

  it('advances steps 2 and 3 without validation', () => {
    expect(reducer(withState({ step: 2 }), { type: 'GO_NEXT' }).step).toBe(3);
    expect(reducer(withState({ step: 3 }), { type: 'GO_NEXT' }).step).toBe(4);
  });
});

describe('GO_BACK', () => {
  it('decrements the step', () => {
    expect(reducer(withState({ step: 3 }), { type: 'GO_BACK' }).step).toBe(2);
  });
  it('does not go below step 1', () => {
    expect(reducer(withState({ step: 1 }), { type: 'GO_BACK' }).step).toBe(1);
  });
});

describe('SET_VOICE_FIELD', () => {
  it('updates one field and clears the copy-from indicator', () => {
    const s = reducer(withState({ copyFromLocationId: 'loc-1' }), {
      type: 'SET_VOICE_FIELD',
      key: 'tone',
      value: 'snappy',
    });
    expect(s.voiceForm.tone).toBe('snappy');
    expect(s.copyFromLocationId).toBe('');
  });

  it('updates list fields', () => {
    const s = reducer(initialState(), {
      type: 'SET_VOICE_FIELD',
      key: 'avoidFacts',
      value: ['x', 'y'],
    });
    expect(s.voiceForm.avoidFacts).toEqual(['x', 'y']);
  });
});

describe('COPY_FROM_EXISTING', () => {
  it('copies the source voice config', () => {
    const s = reducer(withState({ existingLocations: [SOURCE_LOC] }), {
      type: 'COPY_FROM_EXISTING',
      locationId: 'loc-1',
    });
    expect(s.copyFromLocationId).toBe('loc-1');
    expect(s.voiceForm).toEqual({
      tone: 'warm',
      productsServices: 'coffee',
      avoidFacts: ['no discounts'],
      sampleResponses: ['thanks!'],
    });
  });

  it('copies arrays by value (mutating the copy leaves the source intact)', () => {
    const s = reducer(withState({ existingLocations: [SOURCE_LOC] }), {
      type: 'COPY_FROM_EXISTING',
      locationId: 'loc-1',
    });
    s.voiceForm.avoidFacts.push('mutated');
    expect(SOURCE_LOC.avoidFacts).toEqual(['no discounts']);
  });

  it('clears to manual when locationId is empty', () => {
    const s = reducer(
      withState({ existingLocations: [SOURCE_LOC], copyFromLocationId: 'loc-1' }),
      { type: 'COPY_FROM_EXISTING', locationId: '' },
    );
    expect(s.copyFromLocationId).toBe('');
  });

  it('records an unknown locationId but keeps the existing voiceForm', () => {
    const before = withState({ existingLocations: [SOURCE_LOC] });
    const s = reducer(before, { type: 'COPY_FROM_EXISTING', locationId: 'nope' });
    expect(s.copyFromLocationId).toBe('nope');
    expect(s.voiceForm).toEqual(before.voiceForm);
  });
});

describe('async-result actions', () => {
  it('VOICE_CONFIGS_LOADED stores locations and stops loading', () => {
    const s = reducer(initialState(), {
      type: 'VOICE_CONFIGS_LOADED',
      locations: [SOURCE_LOC],
    });
    expect(s.existingLocations).toEqual([SOURCE_LOC]);
    expect(s.voiceLoading).toBe(false);
  });

  it('VOICE_CONFIGS_FAILED stops loading without locations', () => {
    const s = reducer(initialState(), { type: 'VOICE_CONFIGS_FAILED' });
    expect(s.voiceLoading).toBe(false);
    expect(s.existingLocations).toEqual([]);
  });

  it('PLACE_IDS_LOADED builds a Set', () => {
    const s = reducer(initialState(), { type: 'PLACE_IDS_LOADED', placeIds: ['a', 'b'] });
    expect(s.existingPlaceIds).toEqual(new Set(['a', 'b']));
  });
});

describe('submit lifecycle', () => {
  it('SUBMIT_STARTED enters the submitting phase and clears prior error', () => {
    const s = reducer(withState({ submitError: 'old' }), { type: 'SUBMIT_STARTED' });
    expect(s.submitPhase).toBe('submitting');
    expect(s.submitError).toBeNull();
  });

  it('SUBMIT_STARTED clears a connectHref left by an earlier attempt', () => {
    const s = reducer(withState({ connectHref: '/dashboard/connect?locationId=old' }), {
      type: 'SUBMIT_STARTED',
    });
    expect(s.connectHref).toBeNull();
  });

  // #781: the terminal success phase. Without it the wizard could only leave
  // `submitting` by navigating away, so a navigation that never landed left
  // the submit button spinning over an add that had already succeeded.
  it('SUBMIT_SUCCEEDED leaves the submitting phase and records the connect href', () => {
    const s = reducer(withState({ submitPhase: 'submitting' }), {
      type: 'SUBMIT_SUCCEEDED',
      connectHref: '/dashboard/connect?locationId=loc-9',
    });
    expect(s.submitPhase).toBe('succeeded');
    expect(s.connectHref).toBe('/dashboard/connect?locationId=loc-9');
    expect(s.submitError).toBeNull();
  });

  it('SUBMIT_FAILED leaves the submitting phase and records the message', () => {
    const s = reducer(withState({ submitPhase: 'submitting' }), {
      type: 'SUBMIT_FAILED',
      message: 'boom',
    });
    expect(s.submitPhase).toBe('failed');
    expect(s.submitError).toBe('boom');
  });
});
