'use client';

// The admin control plane's one submit-form state machine (#880).
//
// FIVE admin surfaces had hand-written copies of the same `useReducer` — a
// state interface, a 7-to-9-member action union, a switch with one arm per
// member, and an `initialState` — differing only in which fields they held and
// what a success meant. #865 deliberately followed the pattern rather than
// diverging, because extracting it mid-feature would have meant editing four
// unrelated surfaces from a branch whose edit surface did not cover them.
//
// ---------------------------------------------------------------------------
// The design decision the ticket understates (Pathfinder X7)
// ---------------------------------------------------------------------------
//
// X7 records the blocker as `success: boolean` vs `message: string | null`.
// Measured across all five, the success channel is FOUR different things:
//
//   ManualRankingSection    success: boolean            ("Ranking saved")
//   PastDueExtensionPanel   message: string | null      (a formatted deadline)
//   SolicitationBatchPanel  message: string | null      (an announced outcome)
//   ImpersonationStartClient  — none —                  (it navigates away)
//   CsvImportClient         report: CsvImportReport     (a whole object)
//
// So the channel is not unified — it is made a TYPE PARAMETER, and each surface
// says what its success carries. `TOutcome` defaults to `never`, which is the
// honest type for a form that has no success state at all: `succeed` is then
// uncallable and `outcome` is always `null`, checked by the compiler rather
// than by a comment. A surface whose success carries nothing beyond having
// happened passes `true` and reads `outcome` as the flag it already was.
//
// Unifying the four into one `message: string | null` would have been the
// cheap version, and it would have cost the CSV report its structure and given
// the impersonation form a channel it must never populate.
//
// ---------------------------------------------------------------------------
// What is NOT in here, and why
// ---------------------------------------------------------------------------
//
// The FETCH stays in the surface. Every one of the five has a different body,
// a different response shape, a different failure sentence, and two of them log
// under their own prefix. A hook that also owned the request would need a
// config object per surface, which is the knobbed-helper shape this repo
// rejects — and it would put five unrelated copy decisions in one file.
//
// The SECOND error channel stays in the surface. `CsvImportClient` carries
// `validationErrors: ClientCsvValidationError[]` beside its form error. That is
// one surface's affordance, not a shared concern, and it stays local state
// there rather than becoming a field four surfaces never set.
//
// ---------------------------------------------------------------------------
// The order the transitions run in
// ---------------------------------------------------------------------------
//
// `clearOutcome()` → validate → `fail()` on refusal, or `run(body)`.
//
// `run` clears the outcome itself before setting `busy`, so a surface that
// validates nothing can call it directly. The two panels that DO validate call
// `clearOutcome` first, exactly as their `submitReset` action did, so a
// validation refusal is visible while `busy` is still false — the button must
// not announce work that is not happening.
//
// `stop` clears ONLY `busy`. A `fail` or `succeed` raised inside the body
// survives the `finally`, which is what every surface's own `submitDone` did.

import { useCallback, useMemo, useReducer } from 'react';

interface FormState<TFields, TOutcome> {
  fields: TFields;
  busy: boolean;
  error: string | null;
  outcome: TOutcome | null;
}

type FormAction<TFields, TOutcome> =
  | { type: 'set'; key: keyof TFields; value: TFields[keyof TFields] }
  | { type: 'patch'; values: Partial<TFields> }
  | { type: 'clearOutcome' }
  | { type: 'fail'; error: string }
  | { type: 'succeed'; outcome: TOutcome }
  | { type: 'start' }
  | { type: 'stop' };

function reducer<TFields, TOutcome>(
  state: FormState<TFields, TOutcome>,
  action: FormAction<TFields, TOutcome>,
): FormState<TFields, TOutcome> {
  switch (action.type) {
    case 'set':
      return { ...state, fields: { ...state.fields, [action.key]: action.value } };
    case 'patch':
      return { ...state, fields: { ...state.fields, ...action.values } };
    case 'clearOutcome':
      return { ...state, error: null, outcome: null };
    case 'fail':
      return { ...state, error: action.error };
    case 'succeed':
      return { ...state, outcome: action.outcome };
    case 'start':
      return { ...state, busy: true, error: null, outcome: null };
    case 'stop':
      return { ...state, busy: false };
  }
}

export interface AdminActionForm<TFields, TOutcome> {
  /** The current field values. */
  fields: TFields;
  /** True while `run`'s body is in flight. */
  busy: boolean;
  /** The refusal copy for the last `fail`, or null. */
  error: string | null;
  /** What the last success carried, or null. Always null when `TOutcome` is `never`. */
  outcome: TOutcome | null;
  /** One field. Type-safe in both the key and the value. */
  set: <K extends keyof TFields>(key: K, value: TFields[K]) => void;
  /** Several fields at once — a success that clears some of them, typically. */
  patch: (values: Partial<TFields>) => void;
  /** Clears BOTH outcome channels. Call before validating. */
  clearOutcome: () => void;
  /** A refusal: a failed validation, a non-2xx, or a caught throw. */
  fail: (error: string) => void;
  /** A success, carrying whatever this form's success means. */
  succeed: (outcome: TOutcome) => void;
  /** Holds `busy` true across `body` and always clears it afterwards. */
  run: (body: () => Promise<void>) => Promise<void>;
}

/**
 * One submit form's state: its fields, whether a write is in flight, the
 * refusal copy, and what a success carried.
 *
 * `initialFields` may be a value or a factory — `ManualRankingSection` needs a
 * factory because its date field is `todayLocal()`, which must not be captured
 * at module load.
 */
export function useAdminActionForm<TFields extends object, TOutcome = never>(
  initialFields: TFields | (() => TFields),
): AdminActionForm<TFields, TOutcome> {
  const [state, dispatch] = useReducer(
    reducer as (
      state: FormState<TFields, TOutcome>,
      action: FormAction<TFields, TOutcome>,
    ) => FormState<TFields, TOutcome>,
    initialFields,
    (initial): FormState<TFields, TOutcome> => ({
      fields: typeof initial === 'function' ? (initial as () => TFields)() : initial,
      busy: false,
      error: null,
      outcome: null,
    }),
  );

  const set = useCallback(<K extends keyof TFields>(key: K, value: TFields[K]) => {
    dispatch({ type: 'set', key, value: value as TFields[keyof TFields] });
  }, []);

  const patch = useCallback((values: Partial<TFields>) => {
    dispatch({ type: 'patch', values });
  }, []);

  const clearOutcome = useCallback(() => dispatch({ type: 'clearOutcome' }), []);
  const fail = useCallback((error: string) => dispatch({ type: 'fail', error }), []);
  const succeed = useCallback((outcome: TOutcome) => dispatch({ type: 'succeed', outcome }), []);

  const run = useCallback(async (body: () => Promise<void>) => {
    dispatch({ type: 'start' });
    try {
      await body();
    } finally {
      dispatch({ type: 'stop' });
    }
  }, []);

  return useMemo(
    () => ({
      fields: state.fields,
      busy: state.busy,
      error: state.error,
      outcome: state.outcome,
      set,
      patch,
      clearOutcome,
      fail,
      succeed,
      run,
    }),
    [state, set, patch, clearOutcome, fail, succeed, run],
  );
}
