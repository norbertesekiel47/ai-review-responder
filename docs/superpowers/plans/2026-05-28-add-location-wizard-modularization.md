# AddLocationWizard Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 846-LOC `AddLocationWizard.tsx` into a pure reducer, a `useAddLocationWizard` hook, four presentational step components, and a ~95-LOC composing shell — with zero behavior or visual change.

**Architecture:** All synchronous state lives in a pure `reducer.ts` (unit-tested first). The `useAddLocationWizard` hook owns impurity (two fetch effects + async submit + navigation) and exposes a flat state-plus-actions object. Each wizard step is a presentational component receiving explicit prop slices. The shell only composes. Pure billing/payload helpers move to their own modules (no compatibility shim — only test files import them).

**Tech Stack:** Next.js 16 App Router (client components), React `useReducer`, TypeScript strict, Vitest (node environment — no jsdom/RTL), pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-add-location-wizard-modularization-design.md`

**Working branch:** `refactor/modularize-add-location-wizard` (already created; spec already committed there).

**Key paths (all relative to repo root):**
- Shell: `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx`
- New dir: `src/app/(authenticated)/dashboard/add-location/wizard/`
- Tests dir: `src/app/(authenticated)/dashboard/add-location/__tests__/`

**Per-task commit discipline:** commit at the end of each task. Branch already exists; never push to `main`.

---

## Task 1: Shared types + constants (`wizard/types.ts`)

**Files:**
- Create: `src/app/(authenticated)/dashboard/add-location/wizard/types.ts`

- [ ] **Step 1: Create the file**

```ts
// src/app/(authenticated)/dashboard/add-location/wizard/types.ts
//
// Shared types and constants for the Add-location wizard.

import type { PlaceSelection } from '@/components/PlaceAutocomplete';
import type { BillingSnapshot } from '@/lib/accounts/quota';

export interface Props {
  accountId: string;
  billingSnapshot: BillingSnapshot;
  activeLocationCount: number;
}

export type WizardStep = 1 | 2 | 3 | 4;
export type LocationInputMode = 'autocomplete' | 'url';

export interface VoiceFormState {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

export interface ExistingLocationVoice {
  locationId: string;
  displayName: string;
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

export interface Step1LocationInput {
  inputMode: LocationInputMode;
  placeSelection: PlaceSelection | null;
  googleMapsUrl: string;
}

export interface BuildAddLocationPayloadInput extends Step1LocationInput {
  accountId: string;
  displayLabel: string;
  voiceForm: VoiceFormState;
}

export const STEP_INFO: Record<WizardStep, { title: string; subtitle: string }> = {
  1: { title: 'Add location', subtitle: 'Step 1 of 4 — Select location' },
  2: { title: 'Add location', subtitle: 'Step 2 of 4 — Google Business' },
  3: { title: 'Add location', subtitle: 'Step 3 of 4 — Voice config' },
  4: { title: 'Add location', subtitle: 'Step 4 of 4 — Confirm & pay' },
};

export const DEFAULT_VOICE: VoiceFormState = {
  tone: 'professional and friendly',
  productsServices: '',
  avoidFacts: [],
  sampleResponses: [],
};
```

> Note: the `STEP_INFO` subtitles use an em dash (`—`), matching the original verbatim.

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS (new file is valid; nothing imports it yet).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(authenticated)/dashboard/add-location/wizard/types.ts"
git commit -m "refactor(add-location): extract wizard shared types + constants"
```

---

## Task 2: Pure helpers (`wizard/billing.ts`, `wizard/payload.ts`) + rewire imports

**Files:**
- Create: `src/app/(authenticated)/dashboard/add-location/wizard/billing.ts`
- Create: `src/app/(authenticated)/dashboard/add-location/wizard/payload.ts`
- Modify: `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx` (delete the 4 pure fns + their 2 input interfaces; import them instead)
- Modify: `src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts` (import line only)
- Modify: `src/app/(authenticated)/dashboard/add-location/__tests__/deferred-loc-assertions.test.ts` (import line only)

- [ ] **Step 1: Create `wizard/billing.ts`**

```ts
// src/app/(authenticated)/dashboard/add-location/wizard/billing.ts
//
// Pure billing math for the Add-location confirm step.

import type { BillingSnapshot } from '@/lib/accounts/quota';

export interface ProrationResult {
  prorationCents: number;
  daysRemaining: number;
  daysInMonth: number;
}

export interface NextLocationBillingPreview {
  nextOverageUnits: number;
  additionalLocationMonthlyCents: number;
  newMonthlyTotalCents: number;
}

/**
 * Computes the prorated charge for adding a location mid-billing-cycle.
 * Formula: (overagePriceCents / daysInMonth) * remainingDays
 *
 * VAL-LOC-066: proration line shows actual prorated charge.
 */
export function computeProration(
  overagePriceCents: number,
  now: Date = new Date(),
): ProrationResult {
  const year = now.getFullYear();
  const month = now.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = now.getDate();
  const daysRemaining = Math.max(0, daysInMonth - today);

  // Proration: (overage / daysInMonth) * daysRemaining
  // Round to nearest cent
  const prorationCents = Math.round(
    (overagePriceCents / daysInMonth) * daysRemaining,
  );

  return { prorationCents, daysRemaining, daysInMonth };
}

export function computeNextLocationBillingPreview({
  activeLocationCount,
  billingSnapshot,
}: {
  activeLocationCount: number;
  billingSnapshot: BillingSnapshot;
}): NextLocationBillingPreview {
  const nextActiveLocations = activeLocationCount + 1;
  const nextOverageUnits = Math.max(
    0,
    nextActiveLocations - billingSnapshot.includedLocations,
  );
  const additionalOverageUnits = Math.max(
    0,
    nextOverageUnits - billingSnapshot.overageUnits,
  );
  const additionalLocationMonthlyCents =
    additionalOverageUnits * billingSnapshot.overagePriceCents;

  return {
    nextOverageUnits,
    additionalLocationMonthlyCents,
    newMonthlyTotalCents:
      billingSnapshot.basePriceCents +
      nextOverageUnits * billingSnapshot.overagePriceCents,
  };
}
```

- [ ] **Step 2: Create `wizard/payload.ts`**

```ts
// src/app/(authenticated)/dashboard/add-location/wizard/payload.ts
//
// Pure helpers for Step-1 location input and the /api/locations/add payload.

import type { BuildAddLocationPayloadInput, Step1LocationInput } from './types';

export function hasStep1LocationDetails({
  inputMode,
  placeSelection,
  googleMapsUrl,
}: Step1LocationInput): boolean {
  if (inputMode === 'url') return googleMapsUrl.trim().length > 0;
  return placeSelection !== null;
}

export function buildAddLocationPayload({
  accountId,
  displayLabel,
  inputMode,
  placeSelection,
  googleMapsUrl,
  voiceForm,
}: BuildAddLocationPayloadInput) {
  const trimmedMapsUrl = googleMapsUrl.trim();

  return {
    accountId,
    displayLabel: displayLabel.trim(),
    ...(inputMode === 'autocomplete' && placeSelection?.placeId
      ? { googlePlaceId: placeSelection.placeId }
      : {}),
    ...(inputMode === 'url' && trimmedMapsUrl
      ? { googleMapsUrl: trimmedMapsUrl }
      : {}),
    placeIdVerified: inputMode === 'autocomplete' && !!placeSelection,
    voiceConfig: {
      tone: voiceForm.tone,
      productsServices: voiceForm.productsServices || null,
      avoidFacts: voiceForm.avoidFacts.filter(Boolean),
      sampleResponses: voiceForm.sampleResponses.filter(Boolean),
    },
  };
}
```

- [ ] **Step 3: Rewire `AddLocationWizard.tsx` — add imports, delete the moved code**

In `AddLocationWizard.tsx`, add these two imports just below the existing `import type { LocationId } from '@/lib/shared/ids';` line:

```ts
import {
  computeNextLocationBillingPreview,
  computeProration,
} from './wizard/billing';
import { buildAddLocationPayload, hasStep1LocationDetails } from './wizard/payload';
```

Then **delete** the now-duplicated block from `AddLocationWizard.tsx`. This is everything from the `// ── Proration helper ──` banner through the end of `buildAddLocationPayload` — i.e. delete:
- `export function computeProration(...) { ... }`
- `export function computeNextLocationBillingPreview(...) { ... }`
- `interface Step1LocationInput { ... }`
- `interface BuildAddLocationPayloadInput extends Step1LocationInput { ... }`
- `export function hasStep1LocationDetails(...) { ... }`
- `export function buildAddLocationPayload(...) { ... }`

Keep the `DEFAULT_VOICE` constant and the `// ── Default voice config ──` block in place (still used by the component's `useState`; removed later in Task 7). Keep all other types (`Props`, `WizardStep`, `LocationInputMode`, `VoiceFormState`, `ExistingLocationVoice`, `STEP_INFO`).

- [ ] **Step 4: Repoint the pure-fn imports in `AddLocationWizard.test.ts`**

Replace the import block (currently lines ~10–15):

```ts
import {
  buildAddLocationPayload,
  computeNextLocationBillingPreview,
  computeProration,
  hasStep1LocationDetails,
} from '../AddLocationWizard';
```

with:

```ts
import { computeNextLocationBillingPreview, computeProration } from '../wizard/billing';
import { buildAddLocationPayload, hasStep1LocationDetails } from '../wizard/payload';
```

- [ ] **Step 5: Repoint the import in `deferred-loc-assertions.test.ts`**

Replace (line ~16):

```ts
import { computeProration } from '../AddLocationWizard';
```

with:

```ts
import { computeProration } from '../wizard/billing';
```

- [ ] **Step 6: Run the affected tests**

Run: `pnpm test -- src/app/\(authenticated\)/dashboard/add-location`
Expected: PASS — all existing `AddLocationWizard.test.ts` and `deferred-loc-assertions.test.ts` cases green against the relocated functions.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (proves no other import site referenced the moved functions — grep confirmed only these two test files do).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(authenticated)/dashboard/add-location/wizard/billing.ts" \
        "src/app/(authenticated)/dashboard/add-location/wizard/payload.ts" \
        "src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx" \
        "src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts" \
        "src/app/(authenticated)/dashboard/add-location/__tests__/deferred-loc-assertions.test.ts"
git commit -m "refactor(add-location): relocate pure billing/payload helpers (no shim)"
```

---

## Task 3: Pure reducer — test first (`wizard/reducer.ts`)

**Files:**
- Test: `src/app/(authenticated)/dashboard/add-location/__tests__/reducer.test.ts`
- Create: `src/app/(authenticated)/dashboard/add-location/wizard/reducer.ts`

- [ ] **Step 1: Write the failing characterization test**

Create `src/app/(authenticated)/dashboard/add-location/__tests__/reducer.test.ts`:

```ts
// src/app/(authenticated)/dashboard/add-location/__tests__/reducer.test.ts
//
// Characterization suite for the Add-location wizard reducer. Captures the
// exact synchronous transitions previously implemented as inline useState
// setters in AddLocationWizard.tsx.

import { describe, it, expect } from 'vitest';
import { initialState, reducer, type WizardState } from '../wizard/reducer';
import type { PlaceSelection } from '@/components/PlaceAutocomplete';
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
  it('SUBMIT_STARTED sets submitting and clears prior error', () => {
    const s = reducer(withState({ submitError: 'old' }), { type: 'SUBMIT_STARTED' });
    expect(s.submitting).toBe(true);
    expect(s.submitError).toBeNull();
  });

  it('SUBMIT_FAILED clears submitting and records the message', () => {
    const s = reducer(withState({ submitting: true }), {
      type: 'SUBMIT_FAILED',
      message: 'boom',
    });
    expect(s.submitting).toBe(false);
    expect(s.submitError).toBe('boom');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test -- src/app/\(authenticated\)/dashboard/add-location/__tests__/reducer.test.ts`
Expected: FAIL — `Cannot find module '../wizard/reducer'` (module not yet created).

- [ ] **Step 3: Write `wizard/reducer.ts`**

```ts
// src/app/(authenticated)/dashboard/add-location/wizard/reducer.ts
//
// Pure state machine for the Add-location wizard. Every synchronous
// transition that used to be an inline useState setter lives here; the
// useAddLocationWizard hook owns side effects (fetch, submit, navigation)
// and dispatches these actions.

import type { PlaceSelection } from '@/components/PlaceAutocomplete';
import {
  DEFAULT_VOICE,
  type ExistingLocationVoice,
  type LocationInputMode,
  type VoiceFormState,
  type WizardStep,
} from './types';
import { hasStep1LocationDetails } from './payload';

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
  submitting: boolean;
  submitError: string | null;
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
    submitting: false,
    submitError: null,
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
      return { ...state, submitting: true, submitError: null };

    case 'SUBMIT_FAILED':
      return { ...state, submitting: false, submitError: action.message };

    default:
      return state;
  }
}
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `pnpm test -- src/app/\(authenticated\)/dashboard/add-location/__tests__/reducer.test.ts`
Expected: PASS — all reducer cases green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(authenticated)/dashboard/add-location/wizard/reducer.ts" \
        "src/app/(authenticated)/dashboard/add-location/__tests__/reducer.test.ts"
git commit -m "refactor(add-location): extract pure wizard reducer + characterization suite"
```

---

## Task 4: The hook (`wizard/useAddLocationWizard.ts`)

**Files:**
- Create: `src/app/(authenticated)/dashboard/add-location/wizard/useAddLocationWizard.ts`

- [ ] **Step 1: Create the file**

```ts
'use client';

// src/app/(authenticated)/dashboard/add-location/wizard/useAddLocationWizard.ts
//
// Owns all wizard impurity: useReducer + two fetch effects + the async submit
// (POST /api/locations/add → set location scope → navigate to the connect
// flow). Returns a flat state-plus-actions object the shell composes from.

import { useCallback, useEffect, useReducer } from 'react';
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
          (loc: any) => ({
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
```

> Notes: `(loc: any)` is kept verbatim from the original (already lint-clean there). The submit handler keeps `encodeURIComponent(result.businessId)` and `/dashboard/connect?locationId=` and never calls `router.push('/dashboard')` — these are asserted by the repointed guards in Task 6.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (The hook is not yet imported anywhere; this verifies it compiles standalone.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(authenticated)/dashboard/add-location/wizard/useAddLocationWizard.ts"
git commit -m "refactor(add-location): add useAddLocationWizard hook (effects + submit)"
```

---

## Task 5: Step components (`wizard/steps/Step{1..4}*.tsx`)

**Files:**
- Create: `wizard/steps/Step1Location.tsx`
- Create: `wizard/steps/Step2GoogleBusiness.tsx`
- Create: `wizard/steps/Step3Voice.tsx`
- Create: `wizard/steps/Step4Confirm.tsx`

(All under `src/app/(authenticated)/dashboard/add-location/`.)

- [ ] **Step 1: Create `wizard/steps/Step1Location.tsx`**

```tsx
'use client';

// Step 1 — Place autocomplete + display_label input.

import { PlaceAutocomplete, type PlaceSelection } from '@/components/PlaceAutocomplete';
import type { LocationInputMode } from '../types';

interface Step1LocationProps {
  displayLabel: string;
  displayLabelError: string | null;
  inputMode: LocationInputMode;
  googleMapsUrl: string;
  placeIdDuplicateError: string | null;
  onDisplayLabelChange: (value: string) => void;
  onSelectPlace: (selection: PlaceSelection) => void;
  onClearPlace: () => void;
  onMapsUrlChange: (value: string) => void;
  onToggleInputMode: () => void;
}

export function Step1Location({
  displayLabel,
  displayLabelError,
  inputMode,
  googleMapsUrl,
  placeIdDuplicateError,
  onDisplayLabelChange,
  onSelectPlace,
  onClearPlace,
  onMapsUrlChange,
  onToggleInputMode,
}: Step1LocationProps) {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Select your business location</h2>
      <p className="wizard-desc">
        Search for your business on Google. We&apos;ll use this to connect
        your Google Business Profile and import reviews.
      </p>

      <div className="field" style={{ marginTop: 20 }}>
        <label className="field-label" htmlFor="display-label">
          Location name
        </label>
        <input
          id="display-label"
          className={`input ${displayLabelError ? 'input-error' : ''}`}
          value={displayLabel}
          onChange={(e) => onDisplayLabelChange(e.target.value)}
          placeholder="e.g. Downtown Cafe"
          maxLength={255}
          autoFocus
        />
        {displayLabelError && <p className="field-error">{displayLabelError}</p>}
        <div className="field-counter">{displayLabel.length}/255</div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        <label className="field-label">Business address</label>
        {inputMode === 'autocomplete' ? (
          <PlaceAutocomplete
            onPlaceSelect={onSelectPlace}
            onClear={onClearPlace}
            placeholder="Search for your business..."
          />
        ) : (
          <input
            className="input"
            type="url"
            value={googleMapsUrl}
            onChange={(e) => onMapsUrlChange(e.target.value)}
            placeholder="https://maps.google.com/..."
            autoComplete="url"
          />
        )}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onToggleInputMode}
          style={{ marginTop: 8, fontSize: 12, padding: '6px 10px' }}
        >
          {inputMode === 'autocomplete' ? 'Paste Google Maps URL' : 'Use Google search'}
        </button>
        {placeIdDuplicateError && (
          <p className="field-error" style={{ marginTop: 4 }}>
            {placeIdDuplicateError}
          </p>
        )}
      </div>
    </div>
  );
}
```

> The address auto-fill on place-select now lives in the reducer's `SELECT_PLACE` case, so this component just forwards `onSelectPlace(selection)`.

- [ ] **Step 2: Create `wizard/steps/Step2GoogleBusiness.tsx`**

```tsx
'use client';

// Step 2 — Google Business info (informational only; connect later from Settings).

import Link from 'next/link';
import { Icon } from '@/components/dashboard/Icon';

interface Step2GoogleBusinessProps {
  onNext: () => void;
}

export function Step2GoogleBusiness({ onNext }: Step2GoogleBusinessProps) {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Google Business Profile</h2>
      <p className="wizard-desc">
        After adding your location, you can connect your Google Business
        Profile to automatically publish approved responses and import
        reviews. This can be done at any time from Settings.
      </p>

      <div className="wizard-info-box" style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <Icon name="google" size={20} />
          <div>
            <p style={{ fontWeight: 500, marginBottom: 4 }}>
              Connect later from Settings
            </p>
            <p style={{ color: '#6B7280', fontSize: 14 }}>
              After creating your location, go to{' '}
              <Link
                href="/dashboard/connect"
                style={{ color: 'var(--color-teal-500, #0D9488)', textDecoration: 'underline' }}
              >
                Connect
              </Link>{' '}
              or Settings → Locations to link your Google Business
              Profile and start importing reviews.
            </p>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary"
        onClick={onNext}
        style={{ marginTop: 20, width: '100%' }}
      >
        Continue <Icon name="chevron-down" size={14} style={{ transform: 'rotate(-90deg)' }} />
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Create `wizard/steps/Step3Voice.tsx`**

```tsx
'use client';

// Step 3 — Voice config (ToneChipPicker + ListEditor + copy-from-existing).

import { ToneChipPicker } from '@/components/dashboard/settings/ToneChipPicker';
import { ListEditor } from '@/components/dashboard/settings/ListEditor';
import { Icon } from '@/components/dashboard/Icon';
import type { ExistingLocationVoice, VoiceFormState } from '../types';

interface Step3VoiceProps {
  voiceForm: VoiceFormState;
  existingLocations: ExistingLocationVoice[];
  copyFromLocationId: string;
  voiceLoading: boolean;
  onCopyFromExisting: (locationId: string) => void;
  onVoiceFieldChange: <K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) => void;
  onNext: () => void;
}

export function Step3Voice({
  voiceForm,
  existingLocations,
  copyFromLocationId,
  voiceLoading,
  onCopyFromExisting,
  onVoiceFieldChange,
  onNext,
}: Step3VoiceProps) {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Configure your voice</h2>
      <p className="wizard-desc">
        Set how RepWorth writes replies for this location. You can copy
        settings from an existing location or customize from scratch.
      </p>

      {existingLocations.length > 0 && (
        <div className="field" style={{ marginTop: 16, marginBottom: 20 }}>
          <label className="field-label" htmlFor="copy-from">
            Copy from existing location
          </label>
          <select
            id="copy-from"
            className="select"
            value={copyFromLocationId}
            onChange={(e) => onCopyFromExisting(e.target.value)}
          >
            <option value="">Customize manually</option>
            {existingLocations.map((loc) => (
              <option key={loc.locationId} value={loc.locationId}>
                {loc.displayName}
              </option>
            ))}
          </select>
        </div>
      )}

      {voiceLoading ? (
        <p style={{ color: '#6B7280' }}>Loading voice settings…</p>
      ) : (
        <>
          <div className="set-section" style={{ marginBottom: 20 }}>
            <ToneChipPicker
              tone={voiceForm.tone}
              onChange={(v) => onVoiceFieldChange('tone', v)}
            />
          </div>

          <div className="set-section" style={{ marginBottom: 20 }}>
            <div className="set-section-head">
              <div className="set-section-icon sage">
                <Icon name="lightbulb" size={18} />
              </div>
              <div>
                <div className="set-section-title">Products &amp; services</div>
                <div className="set-section-sub">
                  A short description so we know what to highlight.
                </div>
              </div>
            </div>
            <div className="field">
              <textarea
                className="textarea textarea-tall"
                maxLength={2000}
                value={voiceForm.productsServices}
                onChange={(e) => onVoiceFieldChange('productsServices', e.target.value)}
              />
              <div className="field-counter">
                {voiceForm.productsServices.length}/2000
              </div>
            </div>
          </div>

          <div className="set-section" style={{ marginBottom: 20 }}>
            <div className="set-section-head">
              <div className="set-section-icon rose">
                <Icon name="alert" size={18} />
              </div>
              <div>
                <div className="set-section-title">Things to avoid</div>
                <div className="set-section-sub">
                  Topics or claims we shouldn&apos;t mention in replies.
                </div>
              </div>
            </div>
            <ListEditor
              items={voiceForm.avoidFacts}
              onChange={(v) => onVoiceFieldChange('avoidFacts', v)}
              placeholder="e.g. We never discount on weekends"
              addLabel="Add another"
              maxItems={20}
              maxLength={500}
            />
          </div>

          <div className="set-section">
            <div className="set-section-head">
              <div className="set-section-icon amber">
                <Icon name="edit" size={18} />
              </div>
              <div>
                <div className="set-section-title">Sample replies</div>
                <div className="set-section-sub">
                  Your own past replies — the more we have, the more
                  &quot;you&quot; we sound.
                </div>
              </div>
            </div>
            <ListEditor
              items={voiceForm.sampleResponses}
              onChange={(v) => onVoiceFieldChange('sampleResponses', v)}
              placeholder="Paste a reply you're proud of"
              addLabel="Add another"
              maxItems={10}
              maxLength={2000}
            />
          </div>
        </>
      )}

      <button
        type="button"
        className="btn btn-secondary wizard-skip-btn"
        onClick={onNext}
        style={{ marginTop: 20, width: '100%' }}
      >
        Use defaults and continue
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Create `wizard/steps/Step4Confirm.tsx`**

```tsx
'use client';

// Step 4 — Confirm & pay with proration preview.

import { Icon } from '@/components/dashboard/Icon';
import type { PlaceSelection } from '@/components/PlaceAutocomplete';
import type { BillingSnapshot } from '@/lib/accounts/quota';
import type { NextLocationBillingPreview, ProrationResult } from '../billing';
import type { ExistingLocationVoice, LocationInputMode } from '../types';

interface Step4ConfirmProps {
  displayLabel: string;
  placeSelection: PlaceSelection | null;
  inputMode: LocationInputMode;
  googleMapsUrl: string;
  copyFromLocationId: string;
  existingLocations: ExistingLocationVoice[];
  billingSnapshot: BillingSnapshot;
  billingPreview: NextLocationBillingPreview;
  proration: ProrationResult;
  newMonthlyTotalCents: number;
  submitting: boolean;
  submitError: string | null;
  onSubmit: () => void;
}

export function Step4Confirm({
  displayLabel,
  placeSelection,
  inputMode,
  googleMapsUrl,
  copyFromLocationId,
  existingLocations,
  billingSnapshot,
  billingPreview,
  proration,
  newMonthlyTotalCents,
  submitting,
  submitError,
  onSubmit,
}: Step4ConfirmProps) {
  return (
    <div className="wizard-panel">
      <h2 className="wizard-title">Confirm &amp; pay</h2>
      <p className="wizard-desc">
        Review your new location details. Adding a location will update
        your monthly bill.
      </p>

      {submitError && <div className="wizard-error">{submitError}</div>}

      <div className="wizard-summary">
        <div className="wizard-summary-row">
          <span className="wizard-summary-label">Location name</span>
          <span className="wizard-summary-value">{displayLabel.trim()}</span>
        </div>
        {placeSelection && (
          <div className="wizard-summary-row">
            <span className="wizard-summary-label">Address</span>
            <span className="wizard-summary-value">{placeSelection.formattedAddress}</span>
          </div>
        )}
        {!placeSelection && inputMode === 'url' && googleMapsUrl.trim() && (
          <div className="wizard-summary-row">
            <span className="wizard-summary-label">Google Maps URL</span>
            <span className="wizard-summary-value">{googleMapsUrl.trim()}</span>
          </div>
        )}
        <div className="wizard-summary-row">
          <span className="wizard-summary-label">Google Business</span>
          <span className="wizard-summary-value">Connect later from Settings</span>
        </div>
        <div className="wizard-summary-row">
          <span className="wizard-summary-label">Voice config</span>
          <span className="wizard-summary-value">
            {copyFromLocationId
              ? `Copied from ${existingLocations.find((l) => l.locationId === copyFromLocationId)?.displayName ?? 'existing location'}`
              : 'Customized'}
          </span>
        </div>
      </div>

      <div className="wizard-billing">
        <h3 className="wizard-billing-title">Billing summary</h3>

        <div className="wizard-billing-row">
          <span>Current monthly total</span>
          <span>${(billingSnapshot.totalCents / 100).toFixed(2)}/mo</span>
        </div>

        <div className="wizard-billing-row">
          <span>
            + Additional location
            {billingPreview.additionalLocationMonthlyCents > 0 && (
              <span className="wizard-billing-note">
                {' '}(${(billingPreview.additionalLocationMonthlyCents / 100).toFixed(2)}/mo)
              </span>
            )}
          </span>
          <span>
            {billingPreview.additionalLocationMonthlyCents > 0
              ? `$${(billingPreview.additionalLocationMonthlyCents / 100).toFixed(2)}/mo`
              : 'Included'}
          </span>
        </div>

        {billingPreview.additionalLocationMonthlyCents > 0 && proration.daysRemaining > 0 && (
          <div className="wizard-billing-row wizard-billing-proration">
            <span>
              Prorated charge today
              <span className="wizard-billing-note">
                {' '}({proration.daysRemaining} of {proration.daysInMonth} days remaining)
              </span>
            </span>
            <span>${(proration.prorationCents / 100).toFixed(2)}</span>
          </div>
        )}

        <div className="wizard-billing-divider" />

        <div className="wizard-billing-row wizard-billing-total">
          <span>New monthly total</span>
          <span>${(newMonthlyTotalCents / 100).toFixed(2)}/mo</span>
        </div>
      </div>

      <button
        type="button"
        className="btn btn-primary wizard-submit-btn"
        onClick={onSubmit}
        disabled={submitting}
        style={{ marginTop: 24, width: '100%' }}
      >
        {submitting ? (
          <>
            <span className="spinner" /> Adding location…
          </>
        ) : (
          <>
            <Icon name="check" size={14} /> Confirm &amp; add location
          </>
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (Step components compile standalone; not yet used by the shell.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(authenticated)/dashboard/add-location/wizard/steps/"
git commit -m "refactor(add-location): extract Step1..4 presentational components"
```

---

## Task 6: Repoint the source-string guards in `AddLocationWizard.test.ts`

> These guards are now satisfied by the new step + hook files, which already exist after Tasks 4–5. The monolithic `AddLocationWizard.tsx` still contains the old strings at this point, but the guards no longer read it — so the suite stays green here AND after the shell rewrite in Task 7.

**Files:**
- Modify: `src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts`

- [ ] **Step 1: Add a file-reading helper near the top of the test file**

Immediately after the import lines (the ones added in Task 2), add:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readWizardSource(...relPaths: string[]): string {
  return relPaths
    .map((p) => readFileSync(resolve(__dirname, p), 'utf-8'))
    .join('\n');
}
```

- [ ] **Step 2: Replace the `Step 2 Zernio informational-only` describe block**

Replace the entire `describe('Step 2 Zernio informational-only (no OAuth redirect)', ...)` block with:

```ts
// ── Step 2 Zernio informational-only check ───────────────────────────────
//
// VAL-LOC-073: Step 2 is optional and skippable. It must NOT contain any
// OAuth redirect — it shows informational text about connecting Google
// Business later, with a link to /dashboard/connect. After modularization
// the Step-2 UI lives in wizard/steps/Step2GoogleBusiness.tsx and the submit
// navigation lives in wizard/useAddLocationWizard.ts; we guard both.

describe('Step 2 Zernio informational-only (no OAuth redirect)', () => {
  const step2AndHook = () =>
    readWizardSource(
      '../wizard/steps/Step2GoogleBusiness.tsx',
      '../wizard/useAddLocationWizard.ts',
    );

  it('has no handleZernioConnect or window.location redirect', () => {
    const source = step2AndHook();

    // No handleZernioConnect function
    expect(source).not.toContain('handleZernioConnect');

    // No window.location.href assignment (the OAuth redirect pattern)
    expect(source).not.toContain('window.location.href');

    // No /api/zernio/connect/start fetch call (the OAuth initiation)
    expect(source).not.toContain('/api/zernio/connect/start');

    // Step 2 shows the connect-later message and a link to the connect flow
    const step2 = readWizardSource('../wizard/steps/Step2GoogleBusiness.tsx');
    expect(step2).toContain('Connect later from Settings');
    expect(step2).toContain('/dashboard/connect');
  });

  it('has no zernioConnecting or zernioConnected state variables', () => {
    const source = step2AndHook();

    // These state variables were removed — they tracked the OAuth flow
    expect(source).not.toContain('zernioConnecting');
    expect(source).not.toContain('zernioConnected');
    expect(source).not.toContain('zernioError');
  });
});
```

- [ ] **Step 3: Replace the `submit payload shape` describe block**

Replace the entire `describe('submit payload shape', ...)` block with:

```ts
// Submit payload shape
//
// The API schema treats googleMapsUrl as optional, not nullable. When the
// wizard uses Place Autocomplete, it must omit googleMapsUrl entirely. The
// payload builder lives in wizard/payload.ts and the submit navigation in
// wizard/useAddLocationWizard.ts.
describe('submit payload shape', () => {
  it('does not send googleMapsUrl:null for Place Autocomplete submissions', () => {
    const source = readWizardSource('../wizard/payload.ts');
    expect(source).not.toContain('googleMapsUrl: null');
  });

  it('routes the newly added location directly to its Google connect flow', () => {
    const source = readWizardSource('../wizard/useAddLocationWizard.ts');
    expect(source).toContain('/dashboard/connect?locationId=');
    expect(source).toContain('encodeURIComponent(result.businessId)');
    expect(source).not.toContain("router.push('/dashboard');");
  });
});
```

- [ ] **Step 4: Run the add-location tests**

Run: `pnpm test -- src/app/\(authenticated\)/dashboard/add-location`
Expected: PASS — repointed guards read the new files; reducer + pure-fn suites green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(authenticated)/dashboard/add-location/__tests__/AddLocationWizard.test.ts"
git commit -m "test(add-location): repoint source-string guards at modular files"
```

---

## Task 7: Rewrite the shell (`AddLocationWizard.tsx`)

**Files:**
- Modify (replace whole file): `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx`

- [ ] **Step 1: Replace the entire file contents**

```tsx
'use client';

// src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx
//
// 4-step Add-location wizard — composing shell. State + side effects live in
// wizard/useAddLocationWizard; each step is a presentational component under
// wizard/steps/. The shell renders the step indicator, the active step, and
// the bottom Back/Continue navigation.
//
// Steps:
//   1. Place autocomplete + display_label input
//   2. Google Business info (informational only, connect later from Settings)
//   3. Voice config (ToneChipPicker + ListEditor + copy-from-existing shortcut)
//   4. Confirm-and-pay with proration preview
//
// Validation contract: VAL-LOC-073 (wizard completes when Zernio skipped),
// VAL-SETTINGS-043 (display_label validation), VAL-SETTINGS-044 (duplicate
// Place ID rejected).

import { Icon } from '@/components/dashboard/Icon';
import { TopBar } from '@/components/dashboard/TopBar';
import { useAddLocationWizard } from './wizard/useAddLocationWizard';
import type { Props, WizardStep } from './wizard/types';
import { Step1Location } from './wizard/steps/Step1Location';
import { Step2GoogleBusiness } from './wizard/steps/Step2GoogleBusiness';
import { Step3Voice } from './wizard/steps/Step3Voice';
import { Step4Confirm } from './wizard/steps/Step4Confirm';

export function AddLocationWizard(props: Props) {
  const wiz = useAddLocationWizard(props);

  return (
    <>
      <TopBar
        title={wiz.stepInfo.title}
        subtitle={wiz.stepInfo.subtitle}
        rightLink={{ href: '/dashboard', label: 'Cancel' }}
      />
      <div className="wizard-container">
        {/* Step indicator */}
        <div className="wizard-steps">
          {([1, 2, 3, 4] as WizardStep[]).map((s) => (
            <div
              key={s}
              className={`wizard-step-dot ${s === wiz.step ? 'active' : ''} ${s < wiz.step ? 'done' : ''}`}
            >
              <span className="wizard-step-num">{s}</span>
            </div>
          ))}
        </div>

        <div className="wizard-body">
          {wiz.step === 1 && (
            <Step1Location
              displayLabel={wiz.displayLabel}
              displayLabelError={wiz.displayLabelError}
              inputMode={wiz.inputMode}
              googleMapsUrl={wiz.googleMapsUrl}
              placeIdDuplicateError={wiz.placeIdDuplicateError}
              onDisplayLabelChange={wiz.setDisplayLabel}
              onSelectPlace={wiz.selectPlace}
              onClearPlace={wiz.clearPlace}
              onMapsUrlChange={wiz.setMapsUrl}
              onToggleInputMode={wiz.toggleInputMode}
            />
          )}

          {wiz.step === 2 && <Step2GoogleBusiness onNext={wiz.goNext} />}

          {wiz.step === 3 && (
            <Step3Voice
              voiceForm={wiz.voiceForm}
              existingLocations={wiz.existingLocations}
              copyFromLocationId={wiz.copyFromLocationId}
              voiceLoading={wiz.voiceLoading}
              onCopyFromExisting={wiz.copyFromExisting}
              onVoiceFieldChange={wiz.setVoiceField}
              onNext={wiz.goNext}
            />
          )}

          {wiz.step === 4 && (
            <Step4Confirm
              displayLabel={wiz.displayLabel}
              placeSelection={wiz.placeSelection}
              inputMode={wiz.inputMode}
              googleMapsUrl={wiz.googleMapsUrl}
              copyFromLocationId={wiz.copyFromLocationId}
              existingLocations={wiz.existingLocations}
              billingSnapshot={props.billingSnapshot}
              billingPreview={wiz.billingPreview}
              proration={wiz.proration}
              newMonthlyTotalCents={wiz.newMonthlyTotalCents}
              submitting={wiz.submitting}
              submitError={wiz.submitError}
              onSubmit={wiz.handleSubmit}
            />
          )}
        </div>

        {/* Step navigation */}
        <div className="wizard-nav">
          {wiz.step > 1 && (
            <button type="button" className="btn btn-secondary" onClick={wiz.goBack}>
              <Icon name="chevron-down" size={14} style={{ transform: 'rotate(90deg)' }} /> Back
            </button>
          )}
          <div className="wizard-nav-spacer" />
          {wiz.step < 4 && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={wiz.goNext}
              disabled={wiz.step === 1 && !wiz.step1HasLocationDetails}
            >
              Continue <Icon name="chevron-down" size={14} style={{ transform: 'rotate(-90deg)' }} />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full add-location test folder**

Run: `pnpm test -- src/app/\(authenticated\)/dashboard/add-location`
Expected: PASS — reducer suite, pure-fn suites, repointed guards, and deferred-loc assertions all green.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx"
git commit -m "refactor(add-location): reduce AddLocationWizard to composing shell"
```

---

## Task 8: Update `docs/directory.md`

**Files:**
- Modify: `docs/directory.md`

- [ ] **Step 1: Add a row to the `(authenticated)/` route table**

In the `### `(authenticated)/` — Owner login required` table, add this row immediately after the `past-replies/page.tsx` row:

```markdown
| `dashboard/add-location/` | 4-step "add location" wizard (gated by `MULTI_LOCATION_ENABLED`). `AddLocationWizard.tsx` is a composing shell; `wizard/reducer.ts` is the pure state machine; `wizard/useAddLocationWizard.ts` owns the two fetch effects + submit/navigation; `wizard/steps/Step{1..4}*.tsx` are presentational; `wizard/billing.ts` + `wizard/payload.ts` hold the pure proration/payload helpers. |
```

- [ ] **Step 2: Commit**

```bash
git add docs/directory.md
git commit -m "docs(directory): note modular add-location wizard layout"
```

---

## Task 9: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: PASS (0 errors). If `no-explicit-any` flags the `(loc: any)` in the hook, confirm the original `AddLocationWizard.tsx` had the same disable posture; the line is moved verbatim so lint status is unchanged.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS — no regressions across the repo (baseline: 4300/4303 pre-existing pass per session notes; this change adds the reducer suite and must not reduce the pass count).

- [ ] **Step 4: Confirm the LOC reduction**

Run: `wc -l "src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx"`
Expected: ~110 lines (down from 846).

- [ ] **Step 5: Final review + finish the branch**

Use the superpowers:finishing-a-development-branch skill to open the PR against `main` (4 CI checks must go green). Note: this is a UI-only refactor — `ci:tenant-scope` / `ci:rls-audit` are not gating here, but the standard CI lint/typecheck/test/build run on the PR.

---

## Self-Review

**Spec coverage:**
- Pure reducer (all 14 fields, 15 actions, validation folded into `GO_NEXT`, auto-fill in `SELECT_PLACE`) → Task 3. ✅
- `useAddLocationWizard` hook (2 fetch effects + submit + derived) → Task 4. ✅
- 4 presentational steps with explicit prop slices → Task 5. ✅
- `billing.ts` + `payload.ts` relocation, no shim, both importers updated → Task 2. ✅
- Composing shell, `page.tsx` untouched → Task 7. ✅
- Source-string guards repointed → Task 6. ✅
- `docs/directory.md` updated → Task 8. ✅
- Full gate (lint/typecheck/test) → Task 9. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has expected output. ✅

**Type consistency:** `WizardState`/`WizardAction`/`initialState`/`reducer` names are consistent across Tasks 3, 4, and the test. Hook returns `setMapsUrl`/`setDisplayLabel`/`selectPlace`/`clearPlace`/`toggleInputMode`/`setVoiceField`/`copyFromExisting`/`goNext`/`goBack`/`handleSubmit` — the exact prop names consumed by the shell in Task 7 and the step prop interfaces in Task 5 (`onMapsUrlChange`←`setMapsUrl`, `onDisplayLabelChange`←`setDisplayLabel`, `onSelectPlace`←`selectPlace`, `onClearPlace`←`clearPlace`, `onToggleInputMode`←`toggleInputMode`, `onVoiceFieldChange`←`setVoiceField`, `onCopyFromExisting`←`copyFromExisting`, `onNext`←`goNext`, `onSubmit`←`handleSubmit`). `NextLocationBillingPreview`/`ProrationResult` defined in `billing.ts` (Task 2) and consumed in `Step4Confirm` (Task 5) and the hook (Task 4). ✅
