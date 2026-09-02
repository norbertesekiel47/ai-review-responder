'use client';

// src/hooks/useSavedFlash.ts
//
// The "Saved" flash every settings form raises after a successful PUT: true
// for `durationMs`, re-armed (not stacked) by a second save inside the window,
// and cleared on unmount so a late timer never touches unmounted state.
// useSettingsForm and useLocationVoiceForm each carried this by hand.

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_FLASH_MS = 1800;

export interface SavedFlash {
  /** True from `flashSaved()` until the window elapses. */
  savedFlash: boolean;
  /** Raise the flash (and restart the window if one is already running). */
  flashSaved: () => void;
}

export function useSavedFlash(durationMs: number = DEFAULT_FLASH_MS): SavedFlash {
  const [savedFlash, setSavedFlash] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setSavedFlash(false), durationMs);
  }, [durationMs]);

  return { savedFlash, flashSaved };
}
