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
import { getDisplayLabel, type HasDisplayLabelCamelCase } from '@/lib/locations/display-label';

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
  /** Whether the account has more than one location. */
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

function buildPatchInternal(initial: VoiceFormState, current: VoiceFormState): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (current.tone !== initial.tone) patch.tone = current.tone;
  if (current.productsServices !== initial.productsServices) patch.productsServices = current.productsServices || null;
  if (JSON.stringify(current.avoidFacts) !== JSON.stringify(initial.avoidFacts)) {
    patch.avoidFacts = current.avoidFacts.flatMap((l) => {
      const trimmed = l.trim();
      return trimmed ? [trimmed] : [];
    });
  }
  if (JSON.stringify(current.sampleResponses) !== JSON.stringify(initial.sampleResponses)) {
    patch.sampleResponses = current.sampleResponses.flatMap((l) => {
      const trimmed = l.trim();
      return trimmed ? [trimmed] : [];
    });
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

// Exported for testing
export function buildPatch(initial: VoiceFormState, current: VoiceFormState): Record<string, unknown> | null {
  return buildPatchInternal(initial, current);
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useLocationVoiceForm(): UseLocationVoiceForm {
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
        const res = await fetch('/api/settings/voice');
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const json = await res.json();

        if (cancelled) return;

        const locs: LocationVoiceConfig[] = json.locations ?? [];
        const map = new Map<string, LocationFormEntry>();

        for (const loc of locs) {
          const form = configToForm(loc);
          map.set(loc.locationId, {
            config: loc,
            form,
            initial: { ...form },
            saveError: null,
            saving: false,
          });
        }

        setEntries(map);

        // Default selection: primary location, or first location
        const primary = locs.find((l) => l.isPrimary);
        const defaultId = primary?.locationId ?? locs[0]?.locationId ?? null;
        if (defaultId && !selectedLocationId) {
          setSelectedLocationId(defaultId);
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Current entry
  const currentEntry = selectedLocationId ? entries.get(selectedLocationId) : null;

  // Derived state
  const locations = useMemo(
    () => Array.from(entries.values()).map((e) => e.config),
    [entries],
  );

  const isMultiLocation = locations.length > 1;

  const selectedDisplayName = currentEntry?.config.displayName ?? null;

  const dirty = useMemo(() => {
    if (!currentEntry) return false;
    return buildPatchInternal(currentEntry.initial, currentEntry.form) !== null;
  }, [currentEntry]);

  const dirtyCount = useMemo(() => {
    if (!currentEntry) return 0;
    let n = 0;
    const { form, initial } = currentEntry;
    for (const k of Object.keys(form) as (keyof VoiceFormState)[]) {
      if (JSON.stringify(form[k]) !== JSON.stringify(initial[k])) n++;
    }
    return n;
  }, [currentEntry]);

  // Set a form field
  const set = useCallback(<K extends keyof VoiceFormState>(key: K, value: VoiceFormState[K]) => {
    if (!selectedLocationId) return;
    setEntries((prev) => {
      const next = new Map(prev);
      const entry = next.get(selectedLocationId);
      if (!entry) return prev;
      next.set(selectedLocationId, {
        ...entry,
        form: { ...entry.form, [key]: value },
      });
      return next;
    });
  }, [selectedLocationId]);

  // Save the current form
  const save = useCallback(async () => {
    if (!selectedLocationId || !currentEntry) return;
    const patch = buildPatchInternal(currentEntry.initial, currentEntry.form);
    if (!patch) return;

    // Mark saving
    setEntries((prev) => {
      const next = new Map(prev);
      const entry = next.get(selectedLocationId);
      if (!entry) return prev;
      next.set(selectedLocationId, { ...entry, saving: true, saveError: null });
      return next;
    });

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
      setEntries((prev) => {
        const next = new Map(prev);
        const entry = next.get(selectedLocationId);
        if (!entry) return prev;
        next.set(selectedLocationId, {
          ...entry,
          initial: { ...entry.form },
          saving: false,
          saveError: null,
        });
        return next;
      });

      setSavedFlash(true);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      setEntries((prev) => {
        const next = new Map(prev);
        const entry = next.get(selectedLocationId);
        if (!entry) return prev;
        next.set(selectedLocationId, {
          ...entry,
          saving: false,
          saveError: err instanceof Error ? err.message : 'Failed to save',
        });
        return next;
      });
    }
  }, [selectedLocationId, currentEntry]);

  // Discard changes
  const discard = useCallback(() => {
    if (!selectedLocationId) return;
    setEntries((prev) => {
      const next = new Map(prev);
      const entry = next.get(selectedLocationId);
      if (!entry) return prev;
      next.set(selectedLocationId, {
        ...entry,
        form: { ...entry.initial },
      });
      return next;
    });
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
