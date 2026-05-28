# AddLocationWizard Modularization — Design

_Date: 2026-05-28 · Tier-2 candidate from `docs/modular-requirement.md` · Author: pairing session_

## Goal

Decompose `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx`
(846 LOC: 4 inline wizard steps + 14 `useState` + 2 fetch `useEffect`s + 6
callbacks) into a composing shell plus focused units, **with zero behavior or
visual change**. This is a structural refactor, not a feature change.

Seam (from `modular-requirement.md`): each wizard step → its own component;
collapse the local `useState` cluster into a reducer.

## Non-goals

- No markup, copy, class-name, or styling changes. Same DOM output.
- No change to the API contracts (`/api/settings/voice`,
  `/api/locations/existing-place-ids`, `/api/locations/add`).
- No change to `page.tsx` or its import of `{ AddLocationWizard }`.
- No new runtime dependencies.

## Invariants honored

- **Project rule "Route handlers/components orchestrate; modules own behavior."**
  The shell composes; the reducer owns state transitions; the hook owns effects.
- **design.md** — narrow, explicit interfaces (no blanket `{...wiz}` spread into
  steps); no pass-through shim (see "Pure module relocation").
- **engineering.md** — one authoritative owner per fact: validation rules and
  billing math each live in exactly one module.
- **`'use client'`** preserved on the shell; the hook and step components are
  client modules too.

## Current-state inventory (what moves where)

| Current (in `AddLocationWizard.tsx`) | Destination |
|---|---|
| `WizardStep`, `LocationInputMode`, `VoiceFormState`, `ExistingLocationVoice`, `Step1LocationInput`, `BuildAddLocationPayloadInput`, `Props`, `STEP_INFO`, `DEFAULT_VOICE` | `wizard/types.ts` |
| `computeProration`, `computeNextLocationBillingPreview` | `wizard/billing.ts` |
| `hasStep1LocationDetails`, `buildAddLocationPayload` | `wizard/payload.ts` |
| 14 `useState` + `validateStep1` + `goNext`/`goBack`/`setVoiceField`/`handleCopyFromExisting` (sync transitions) | `wizard/reducer.ts` |
| `useReducer` + 2 fetch `useEffect`s + `handleSubmit` + derived values | `wizard/useAddLocationWizard.ts` |
| Step 1 JSX | `wizard/steps/Step1Location.tsx` |
| Step 2 JSX (`'Connect later from Settings'` + `/dashboard/connect` Link) | `wizard/steps/Step2GoogleBusiness.tsx` |
| Step 3 JSX | `wizard/steps/Step3Voice.tsx` |
| Step 4 JSX (summary + billing breakdown + submit button) | `wizard/steps/Step4Confirm.tsx` |
| `AddLocationWizard` component (TopBar, step dots, body switch, bottom nav) | `AddLocationWizard.tsx` (shell, ~110 LOC) |

## Target layout

```
add-location/
├─ AddLocationWizard.tsx        # shell: pure composition; exports AddLocationWizard
├─ page.tsx                     # UNCHANGED
├─ wizard/
│  ├─ types.ts
│  ├─ reducer.ts                # WizardState, Action union, initialState(), reducer() — PURE
│  ├─ billing.ts                # computeProration, computeNextLocationBillingPreview
│  ├─ payload.ts                # hasStep1LocationDetails, buildAddLocationPayload
│  ├─ useAddLocationWizard.ts   # useReducer + 2 fetch effects + handleSubmit + derived
│  └─ steps/
│     ├─ Step1Location.tsx
│     ├─ Step2GoogleBusiness.tsx
│     ├─ Step3Voice.tsx
│     └─ Step4Confirm.tsx
└─ __tests__/
   ├─ AddLocationWizard.test.ts       # pure-fn imports + source-string guards REPOINTED
   ├─ deferred-loc-assertions.test.ts # one import line updated (computeProration)
   └─ reducer.test.ts                 # NEW — characterization suite for the pure reducer
```

## The reducer (`wizard/reducer.ts`)

`WizardState` holds all 14 fields currently in `useState`:

```ts
interface WizardState {
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
```

`initialState()` reproduces today's defaults: `step: 1`, `inputMode:
'autocomplete'`, `voiceForm: { ...DEFAULT_VOICE }`, `voiceLoading: true`, empty
collections.

Action set (each maps 1:1 to an existing transition; the table notes preserved
nuances):

| Action | Replaces | Preserved logic |
|---|---|---|
| `SET_DISPLAY_LABEL` | display-label input `onChange` | clears `displayLabelError` |
| `SELECT_PLACE` | `PlaceAutocomplete.onPlaceSelect` | clears `googleMapsUrl` + `placeIdDuplicateError`; **auto-fills `displayLabel` from address first segment when label is empty** |
| `CLEAR_PLACE` | `PlaceAutocomplete.onClear` | sets `placeSelection: null` |
| `SET_MAPS_URL` | URL input `onChange` | |
| `TOGGLE_INPUT_MODE` | the "Paste URL / Use search" button | clears `placeIdDuplicateError`; on `autocomplete→url` clears `placeSelection`; on `url→autocomplete` clears `googleMapsUrl` |
| `GO_NEXT` | `goNext` | **runs step-1 validation inline** (VAL-SETTINGS-043 non-empty + ≤255; VAL-SETTINGS-044 duplicate Place ID). On invalid: sets the relevant error, does not advance. On valid: clears errors, `step = min(step+1, 4)`. For steps 2–3: advance directly. |
| `GO_BACK` | `goBack` | `step = max(step-1, 1)` |
| `SET_VOICE_FIELD` | `setVoiceField` | updates one `voiceForm` key; clears `copyFromLocationId` |
| `COPY_FROM_EXISTING` | `handleCopyFromExisting` | sets `copyFromLocationId`; when non-empty and source found, copies `tone/productsServices/avoidFacts/sampleResponses` (slicing arrays) |
| `VOICE_CONFIGS_LOADED` | voice fetch success | sets `existingLocations`, `voiceLoading: false` |
| `VOICE_CONFIGS_FAILED` | voice fetch non-ok/throw | `voiceLoading: false` |
| `PLACE_IDS_LOADED` | place-ids fetch success | `existingPlaceIds = new Set(placeIds)` |
| `SUBMIT_STARTED` | `handleSubmit` entry | `submitting: true`, `submitError: null` |
| `SUBMIT_FAILED` | `handleSubmit` error path | `submitting: false`, `submitError: message` |

Submit **success** performs navigation only (no state reset) — identical to
today, so there is no `SUBMIT_SUCCEEDED` action.

The reducer treats `Set` immutably (always constructs a new `Set`). Validation
rule text (`'Location name is required'`, `'Location name must be 255 characters
or less'`, `'This location is already added'`) is reproduced verbatim.

## The hook (`wizard/useAddLocationWizard.ts`)

```ts
export function useAddLocationWizard(props: {
  accountId: string;
  billingSnapshot: BillingSnapshot;
  activeLocationCount: number;
}): {
  // state
  step; inputMode; placeSelection; googleMapsUrl; displayLabel;
  displayLabelError; placeIdDuplicateError; voiceForm; existingLocations;
  copyFromLocationId; voiceLoading; submitting; submitError;
  // derived
  billingPreview; proration; newMonthlyTotalCents; step1HasLocationDetails; stepInfo;
  // actions
  goNext; goBack; selectPlace; clearPlace; setDisplayLabel; setMapsUrl;
  toggleInputMode; setVoiceField; copyFromExisting; handleSubmit;
}
```

Owns all impurity:

- `useReducer(reducer, undefined, initialState)`.
- `useRouter()` + `useLocationScope()`.
- **Voice-config fetch effect** → `VOICE_CONFIGS_LOADED` / `VOICE_CONFIGS_FAILED`
  (cancel-on-unmount preserved).
- **Existing-place-ids fetch effect** → `PLACE_IDS_LOADED` (cancel-on-unmount
  preserved).
- **`handleSubmit`**: `SUBMIT_STARTED` → POST `buildAddLocationPayload(state)` →
  on non-ok `SUBMIT_FAILED(body.error ?? body.detail ?? …)` → on ok
  `setLocationScope(businessId)` + `router.push('/dashboard/connect?locationId=…'
  | '/dashboard/connect')` + `router.refresh()`; network throw → `SUBMIT_FAILED`.
- Derived values via `billing.ts` (`computeNextLocationBillingPreview`,
  `computeProration`) and `payload.ts` (`hasStep1LocationDetails`), plus
  `STEP_INFO[step]`.

Action dispatchers are stable `useCallback`s wrapping `dispatch`.

## Step components (presentational; explicit prop slices)

Each receives only what it renders — narrow interfaces, no `{...wiz}` spread.

- **`Step1Location`**: `displayLabel`, `displayLabelError`, `inputMode`,
  `googleMapsUrl`, `placeIdDuplicateError` + callbacks `setDisplayLabel`,
  `selectPlace`, `clearPlace`, `setMapsUrl`, `toggleInputMode`.
- **`Step2GoogleBusiness`**: `onNext`. Static informational panel; owns the
  `'Connect later from Settings'` copy and the `/dashboard/connect` `Link`.
- **`Step3Voice`**: `voiceForm`, `existingLocations`, `copyFromLocationId`,
  `voiceLoading` + `setVoiceField`, `copyFromExisting`, `onNext`.
- **`Step4Confirm`**: `displayLabel`, `placeSelection`, `inputMode`,
  `googleMapsUrl`, `copyFromLocationId`, `existingLocations`, `billingSnapshot`,
  `billingPreview`, `proration`, `newMonthlyTotalCents`, `submitting`,
  `submitError` + `onSubmit`.

## The shell (`AddLocationWizard.tsx`, ~110 LOC)

```tsx
export function AddLocationWizard(props: Props) {
  const wiz = useAddLocationWizard(props);
  return (
    <>
      <TopBar title={wiz.stepInfo.title} subtitle={wiz.stepInfo.subtitle}
              rightLink={{ href: '/dashboard', label: 'Cancel' }} />
      <div className="wizard-container">
        {/* step dots — unchanged */}
        <div className="wizard-body">
          {wiz.step === 1 && <Step1Location … />}
          {wiz.step === 2 && <Step2GoogleBusiness onNext={wiz.goNext} />}
          {wiz.step === 3 && <Step3Voice … />}
          {wiz.step === 4 && <Step4Confirm … />}
        </div>
        {/* bottom nav: Back / Continue, Continue disabled when
            step === 1 && !wiz.step1HasLocationDetails — unchanged */}
      </div>
    </>
  );
}
```

## Pure module relocation (no shim — rationale)

Grep across `src/`, `worker/`, `scripts/` confirms the **only** importers of the
four pure functions are the two test files:

- `__tests__/AddLocationWizard.test.ts` — imports all four from `'../AddLocationWizard'`.
- `__tests__/deferred-loc-assertions.test.ts` — imports `computeProration` from `'../AddLocationWizard'`.

No production/worker/script code imports them; `page.tsx` imports only the
`AddLocationWizard` component (staying in the shell). A re-export shim would
therefore be pure pass-through serving zero real callers (rejected by design.md).

**Decision: relocate, no shim.** Move the functions to `wizard/billing.ts` and
`wizard/payload.ts`; update the two test imports. `pnpm typecheck` fails on any
missed import anywhere in the repo, so completeness is verified, not assumed.

## Test strategy (TDD order)

1. **Write `reducer.test.ts` first** — characterization suite covering every
   action, both validation branches (empty/too-long label, duplicate Place ID),
   the `SELECT_PLACE` auto-fill, `TOGGLE_INPUT_MODE` field clearing, and
   `COPY_FROM_EXISTING` array copying. State-in → state-out. This is the safety
   net before extraction (mirrors the `useEditReplyDraft` 22-case precedent).
2. Extract `reducer.ts`; run `reducer.test.ts` → green.
3. Build `billing.ts`, `payload.ts`, `types.ts`; build `useAddLocationWizard.ts`;
   build the 4 step components; reduce the shell to composition.
4. **Repoint the source-string guards** in `AddLocationWizard.test.ts`:
   - Positives `'Connect later from Settings'`, `/dashboard/connect` → read
     `../wizard/steps/Step2GoogleBusiness.tsx`.
   - Submit assertions `'/dashboard/connect?locationId='`,
     `encodeURIComponent(result.businessId)`, absence of `router.push('/dashboard')`
     → read `../wizard/useAddLocationWizard.ts`.
   - Absence of `googleMapsUrl: null` → read `../wizard/payload.ts`.
   - OAuth-negative guards (`handleZernioConnect`, `window.location.href`,
     `/api/zernio/connect/start`, `zernioConnecting`, `zernioConnected`,
     `zernioError`) → read `../wizard/steps/Step2GoogleBusiness.tsx` and
     `../wizard/useAddLocationWizard.ts`.
   - Pure-fn imports → `'../wizard/billing'` and `'../wizard/payload'`.
5. Update the single `computeProration` import in `deferred-loc-assertions.test.ts`
   to `'../wizard/billing'`.
6. Update `docs/directory.md` to list the new `wizard/` tree.

## Behavior-preservation checklist

- `page.tsx` import unchanged; component export still from the shell.
- DOM output byte-identical (same JSX/classes/copy, same `STEP_INFO`).
- Both fetch effects keep cancel-on-unmount; failure paths stay non-blocking.
- `handleSubmit` navigation + scope-cookie behavior identical.
- Existing tests in both `__tests__` files pass after import/guard repointing;
  no assertion semantics changed.

## Verification

```
pnpm lint && pnpm typecheck && pnpm test
```

No DB or tenant-scoped query is touched, so `ci:tenant-scope` / `ci:rls-audit`
are not required for this change (UI-only refactor).

## Task breakdown (for the implementation plan)

1. `reducer.test.ts` characterization suite (write first, expect red).
2. `types.ts` + `reducer.ts` → suite green.
3. `billing.ts` + `payload.ts`; repoint both test files' pure-fn imports.
4. `useAddLocationWizard.ts`.
5. `steps/Step1Location.tsx` … `steps/Step4Confirm.tsx`.
6. Shrink `AddLocationWizard.tsx` to the composing shell.
7. Repoint source-string guards in `AddLocationWizard.test.ts`.
8. Update `docs/directory.md`.
9. Full gate: `pnpm lint && pnpm typecheck && pnpm test`.
