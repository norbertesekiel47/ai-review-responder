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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// ── Hook ─────────────────────────────────────────────────────────────────

export function useLocationVoiceForm(
  { multiLocationEnabled }: UseLocationVoiceFormOptions,
): UseLocationVoiceForm {
  const [entries, setEntries] = useState<Map<string, LocationFormEntry>>(new Map());
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup flash timeout on unmount
  useEffect(
    () => () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    },
    [],
  );

  // Fetch all location voice configs on mount
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // The fetch, the error shape and the indexing live in
        // fetchLocationEntries; what stays here is only the effect's own
        // concern — do not touch state after unmount.
        const { entries: loaded, defaultLocationId } = await fetchLocationEntries();

        if (cancelled) return;

        setEntries(loaded);
        if (defaultLocationId && !selectedLocationId) {
          setSelectedLocationId(defaultLocationId);
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : 'Failed to load voice settings');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
    // exhaustive-deps: mount-only initial fetch — load voice settings once; the
    // `cancelled` flag prevents a state update after unmount. Not re-run per render.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Current entry
  const currentEntry = selectedLocationId ? entries.get(selectedLocationId) : null;

  // Derived state
  const locations = useMemo(
    () => Array.from(entries.values()).map((e) => e.config),
    [entries],
  );

  // Server-resolved mode, verbatim — see UseLocationVoiceFormOptions. A local
  // `locations.length > 1` here would render the multi-location voice UI for an
  // account with the feature flag OFF.
  const isMultiLocation = multiLocationEnabled;

  const selectedDisplayName = currentEntry?.config.displayName ?? null;

  const dirty = useMemo(() => {
    if (!currentEntry) return false;
    return buildPatchInternal(currentEntry.initial, currentEntry.form) !== null;
  }, [currentEntry]);

  const dirtyCount = useMemo(() => {
    if (!currentEntry) return 0;
    return countDirtyFields(currentEntry.initial, currentEntry.form);
  }, [currentEntry]);

  // Set a form field
  const set = useCallback(<K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) => {
    if (!selectedLocationId) return;
    setEntries((prev) => updateEntry(prev, selectedLocationId, (entry) => ({
      ...entry,
      form: { ...entry.form, [key]: value },
    })));
  }, [selectedLocationId]);

  // Save the current form
  const save = useCallback(async () => {
    if (!selectedLocationId || !currentEntry) return;
    const patch = buildPatchInternal(currentEntry.initial, currentEntry.form);
    if (!patch) return;

    // Mark saving
    setEntries((prev) => updateEntry(prev, selectedLocationId, (entry) => ({
      ...entry,
      saving: true,
      saveError: null,
    })));

    try {
      const res = await fetch('/api/settings/voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId: selectedLocationId, ...patch }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }

      // Update initial to match current form (mark as saved)
      setEntries((prev) => updateEntry(prev, selectedLocationId, (entry) => ({
        ...entry,
        initial: { ...entry.form },
        saving: false,
        saveError: null,
      })));

      setSavedFlash(true);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      setEntries((prev) => updateEntry(prev, selectedLocationId, (entry) => ({
        ...entry,
        saving: false,
        saveError: err instanceof Error ? err.message : 'Failed to save',
      })));
    }
  }, [selectedLocationId, currentEntry]);

  // Discard changes
  const discard = useCallback(() => {
    if (!selectedLocationId) return;
    setEntries((prev) => updateEntry(prev, selectedLocationId, (entry) => ({
      ...entry,
      form: { ...entry.initial },
    })));
  }, [selectedLocationId]);

  return {
    locations,
    selectedLocationId,
    setSelectedLocationId,
    form: currentEntry?.form ?? null,
    dirty,
    dirtyCount,
    saving: currentEntry?.saving ?? false,
    saveError: currentEntry?.saveError ?? null,
    savedFlash,
    set,
    save,
    discard,
    loading,
    fetchError,
    isMultiLocation,
    selectedDisplayName,
  };
}
