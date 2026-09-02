'use client';

// src/hooks/useLocationVoiceForm.ts
//
// Hook for managing per-location voice configuration in the Voice tab.
// Supports location selector switching, independent form state per location,
// and per-location save/discard operations.
//
// VAL-SETTINGS-017: Voice tab renders per-location voice config sections.
// VAL-SETTINGS-018: Voice config for each location is independently editable.
// VAL-SETTINGS-036: Voice tab for single-location account.

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { useSavedFlash } from '@/hooks/useSavedFlash';
import {
  buildVoiceFieldsPatch,
  countDirtyFields,
  patchOrNull,
} from './settings-form-patch';

// ── Types ────────────────────────────────────────────────────────────────

export interface LocationVoiceConfig {
  locationId: string;
  displayName: string;
  isPrimary: boolean;
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

export interface VoiceFormState {
  tone: string;
  productsServices: string;
  avoidFacts: string[];
  sampleResponses: string[];
}

interface LocationFormEntry {
  config: LocationVoiceConfig;    // server snapshot (for dirty detection)
  form: VoiceFormState;           // current editable state
  initial: VoiceFormState;        // saved state (for discard)
  saveError: string | null;
  saving: boolean;
}

export interface UseLocationVoiceFormOptions {
  /**
   * Multi-location MODE, resolved on the server by
   * `shouldUseMultiLocationSettings(multiLocationEnabled(), activeLocationCount)`
   * and passed down from `settings/voice/page.tsx`.
   *
   * The hook must NEVER re-derive this from `locations.length` and must never
   * read a flag itself: `locations.length > 1` drops the MULTI_LOCATION_ENABLED
   * half of the check (invariant #9b — mode / visibility / eligibility are three
   * checks that never collapse into one boolean), and a client-side flag read
   * would violate invariant #13.
   */
  multiLocationEnabled: boolean;
}

export interface UseLocationVoiceForm {
  /** All locations with their voice config. */
  locations: LocationVoiceConfig[];
  /** Currently selected location ID. */
  selectedLocationId: string | null;
  /** Change the selected location. */
  setSelectedLocationId: (id: string) => void;
  /** The form state for the currently selected location. */
  form: VoiceFormState | null;
  /** Whether the current form is dirty (differs from saved state). */
  dirty: boolean;
  /** Number of dirty fields. */
  dirtyCount: number;
  /** Whether the current form is saving. */
  saving: boolean;
  /** Save error for the current form. */
  saveError: string | null;
  /** Whether a save was just completed (for flash animation). */
  savedFlash: boolean;
  /** Set a form field value. */
  set: <K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) => void;
  /** Save the current form. */
  save: () => Promise<void>;
  /** Discard changes on the current form. */
  discard: () => void;
  /** Loading state. */
  loading: boolean;
  /** Fetch error. */
  fetchError: string | null;
  /** Whether this account is in multi-location settings mode (server-resolved). */
  isMultiLocation: boolean;
  /** Display name for the currently selected location. */
  selectedDisplayName: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function settingsToForm(c: LocationVoiceConfig): VoiceFormState {
  return {
    tone: c.tone,
    productsServices: c.productsServices,
    avoidFacts: c.avoidFacts.slice(),
    sampleResponses: c.sampleResponses.slice(),
  };
}

// Exported for testing
export function configToForm(c: LocationVoiceConfig): VoiceFormState {
  return settingsToForm(c);
}

// This form is exactly the four shared voice fields — no extras — so the whole
// patch comes from the shared owner (settings-form-patch.ts).
function buildPatchInternal(initial: VoiceFormState, current: VoiceFormState): Record<string, unknown> | null {
  return patchOrNull(buildVoiceFieldsPatch(initial, current));
}

// Exported for testing
export function buildPatch(initial: VoiceFormState, current: VoiceFormState): Record<string, unknown> | null {
  return buildPatchInternal(initial, current);
}

/**
 * Replace one location's entry, leaving the map untouched when that location is
 * no longer present (a location archived while its form was open). The five
 * `setEntries` closures in the hook each spelled this out — copy the map, look
 * the entry up, bail to `prev` if it vanished — which is where most of the
 * hook's cognitive complexity lived.
 *
 * Same observable result as the closures it replaces: identity-unchanged map on
 * a miss, fresh map with exactly one key rewritten on a hit.
 */
function updateEntry(
  entries: Map<string, LocationFormEntry>,
  locationId: string,
  update: (entry: LocationFormEntry) => LocationFormEntry,
): Map<string, LocationFormEntry> {
  const entry = entries.get(locationId);
  if (!entry) return entries;
  const next = new Map(entries);
  next.set(locationId, update(entry));
  return next;
}

type EntriesState = Map<string, LocationFormEntry>;

function getSelectedEntry(entries: EntriesState, selectedLocationId: string | null): LocationFormEntry | null {
  return selectedLocationId ? entries.get(selectedLocationId) ?? null : null;
}

/** Everything the tab reads off the selected entry, with the nothing-selected defaults in one place. */
function selectedEntryView(
  entry: LocationFormEntry | null,
): Pick<UseLocationVoiceForm, 'form' | 'saving' | 'saveError' | 'selectedDisplayName'> {
  return {
    form: entry?.form ?? null,
    saving: entry?.saving ?? false,
    saveError: entry?.saveError ?? null,
    selectedDisplayName: entry?.config.displayName ?? null,
  };
}

/** Rewrite the selected location's entry through `setEntries`; a no-op with nothing selected. */
function updateSelectedEntry(
  setEntries: Dispatch<SetStateAction<EntriesState>>,
  selectedLocationId: string | null,
  update: (entry: LocationFormEntry) => LocationFormEntry,
): void {
  if (!selectedLocationId) return;
  setEntries((prev) => updateEntry(prev, selectedLocationId, update));
}

// The four ways a location's entry changes, as pure transitions so the hook's
// save/discard read as the sequence of transitions and nothing else.
const markSaving = (entry: LocationFormEntry): LocationFormEntry => ({
  ...entry,
  saving: true,
  saveError: null,
});
const markSaved = (entry: LocationFormEntry): LocationFormEntry => ({
  ...entry,
  initial: { ...entry.form },
  saving: false,
  saveError: null,
});
const markSaveFailed = (err: unknown) => (entry: LocationFormEntry): LocationFormEntry => ({
  ...entry,
  saving: false,
  saveError: err instanceof Error ? err.message : 'Failed to save',
});
const discardEdits = (entry: LocationFormEntry): LocationFormEntry => ({
  ...entry,
  form: { ...entry.initial },
});

/**
 * GET every location's voice config and index it by location id, plus which
 * location the tab should open on (primary, else the first).
 *
 * Extracted from the mount effect so the effect keeps only its own concern —
 * the `cancelled` guard around each state write. Nothing here touches React
 * state, so it is safe to complete after unmount; the caller drops the result.
 */
async function fetchLocationEntries(): Promise<{
  entries: Map<string, LocationFormEntry>;
  defaultLocationId: string | null;
}> {
  const res = await fetch('/api/settings/voice');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  const json = await res.json();
  const locs: LocationVoiceConfig[] = json.locations ?? [];

  const entries = new Map<string, LocationFormEntry>();
  for (const loc of locs) {
    const form = configToForm(loc);
    entries.set(loc.locationId, {
      config: loc,
      form,
      initial: { ...form },
      saveError: null,
      saving: false,
    });
  }

  const primary = locs.find((l) => l.isPrimary);
  return {
    entries,
    defaultLocationId: primary?.locationId ?? locs[0]?.locationId ?? null,
  };
}

/**
 * PUT one location's changed voice fields. Throws with the server's error
 * string (or a status fallback) so the hook owns only its own state writes.
 */
async function putVoicePatch(locationId: string, patch: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/settings/voice', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locationId, ...patch }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Save failed (${res.status})`);
  }
}

/** Whether (and how much of) an entry's form differs from its saved state; nothing selected → clean. */
function dirtyStateOf(entry: LocationFormEntry | null | undefined): { dirty: boolean; dirtyCount: number } {
  if (!entry) return { dirty: false, dirtyCount: 0 };
  return {
    dirty: buildPatchInternal(entry.initial, entry.form) !== null,
    dirtyCount: countDirtyFields(entry.initial, entry.form),
  };
}

type LoadedVoiceEntries = Awaited<ReturnType<typeof fetchLocationEntries>>;

/**
 * Mount-only fetch of every location's voice config. The fetch, the error
 * shape and the indexing live in fetchLocationEntries; what lives here is only
 * the effect's own concern — never touch state (or call `onLoaded`) after
 * unmount — plus the loading / fetch-error pair that concern produces.
 */
function useVoiceEntriesLoader(
  onLoaded: (loaded: LoadedVoiceEntries) => void,
): { loading: boolean; fetchError: string | null } {
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchLocationEntries()
      .then((loaded) => {
        if (!cancelled) onLoaded(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : 'Failed to load voice settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
    // exhaustive-deps: mount-only initial fetch — load voice settings once; the
    // `cancelled` flag prevents a state update after unmount. Not re-run per render.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { loading, fetchError };
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useLocationVoiceForm(
  { multiLocationEnabled }: UseLocationVoiceFormOptions,
): UseLocationVoiceForm {
  const [entries, setEntries] = useState<EntriesState>(new Map());
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const { savedFlash, flashSaved } = useSavedFlash();

  // Fetch all location voice configs on mount
  const { loading, fetchError } = useVoiceEntriesLoader(({ entries: loaded, defaultLocationId }) => {
    setEntries(loaded);
    if (defaultLocationId && !selectedLocationId) {
      setSelectedLocationId(defaultLocationId);
    }
  });

  // Current entry
  const currentEntry = getSelectedEntry(entries, selectedLocationId);

  // Derived state
  const locations = useMemo(
    () => Array.from(entries.values()).map((e) => e.config),
    [entries],
  );

  // Server-resolved mode, verbatim — see UseLocationVoiceFormOptions. A local
  // `locations.length > 1` here would render the multi-location voice UI for an
  // account with the feature flag OFF.
  const isMultiLocation = multiLocationEnabled;

  const { dirty, dirtyCount } = useMemo(() => dirtyStateOf(currentEntry), [currentEntry]);

  // The CURRENT location's dirty state is the whole truth: VoiceClient refuses
  // to switch locations while dirty (discard first), so no other entry can be
  // holding edits behind the selector.
  useUnsavedChangesGuard(dirty);

  // Set a form field
  const set = useCallback(<K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) => {
    updateSelectedEntry(setEntries, selectedLocationId, (entry) => ({
      ...entry,
      form: { ...entry.form, [key]: value },
    }));
  }, [selectedLocationId]);

  // Save the current form
  const save = useCallback(async () => {
    if (!selectedLocationId || !currentEntry) return;
    const patch = buildPatchInternal(currentEntry.initial, currentEntry.form);
    if (!patch) return;

    updateSelectedEntry(setEntries, selectedLocationId, markSaving);
    try {
      await putVoicePatch(selectedLocationId, patch);
      updateSelectedEntry(setEntries, selectedLocationId, markSaved);
      flashSaved();
    } catch (err) {
      updateSelectedEntry(setEntries, selectedLocationId, markSaveFailed(err));
    }
  }, [selectedLocationId, currentEntry, flashSaved]);

  // Discard changes
  const discard = useCallback(() => {
    updateSelectedEntry(setEntries, selectedLocationId, discardEdits);
  }, [selectedLocationId]);

  return {
    locations,
    selectedLocationId,
    setSelectedLocationId,
    ...selectedEntryView(currentEntry),
    dirty,
    dirtyCount,
    savedFlash,
    set,
    save,
    discard,
    loading,
    fetchError,
    isMultiLocation,
  };
}
