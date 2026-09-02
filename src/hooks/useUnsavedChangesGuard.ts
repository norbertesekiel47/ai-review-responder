'use client';

// src/hooks/useUnsavedChangesGuard.ts
//
// One owner of "this settings page has unsaved edits". Two things read it:
//
//   1. The browser, via `beforeunload` — closing the tab, reloading, or typing a
//      new URL while a form is dirty gets the native "Leave site?" prompt.
//   2. `SettingsSidebar`, via `useHasUnsavedChanges()` — an in-app navigation
//      away from a dirty form is intercepted and confirmed in a `SettingsModal`
//      before the route changes (the App Router has no route-blocking API, so
//      the sidebar is the chokepoint; it is the only settings-to-settings nav).
//
// The store is module-level rather than a React context because the settings
// layout is a server component: the sidebar and each page's form live in
// sibling client trees with no shared client ancestor to hang a provider on.
// A form registers by calling `useUnsavedChangesGuard(dirty)`; unmounting (a
// completed navigation) clears its entry, so a stale flag cannot outlive the
// page that raised it.

import { useEffect, useSyncExternalStore } from 'react';

let nextId = 0;
const dirtyForms = new Set<number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while at least one mounted form reports unsaved edits. */
export function readUnsavedChanges(): boolean {
  return dirtyForms.size > 0;
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (!readUnsavedChanges()) return;
  // Both halves are needed: modern browsers honour preventDefault, older ones
  // read returnValue. The prompt text itself is browser-owned.
  event.preventDefault();
  event.returnValue = '';
}

/**
 * Register a form's dirty state with the shared store and arm the browser's
 * leave-page prompt while it is dirty. Call once per form hook.
 */
export function useUnsavedChangesGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const id = nextId++;
    dirtyForms.add(id);
    emit();
    // The listener is attached per dirty form and removed with it, so a page
    // with no dirty form leaves no `beforeunload` handler behind (browsers
    // skip bfcache for pages that hold one).
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      dirtyForms.delete(id);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      emit();
    };
  }, [dirty]);
}

/** Subscribe to the shared flag — for navigation chrome, not for forms. */
export function useHasUnsavedChanges(): boolean {
  return useSyncExternalStore(subscribe, readUnsavedChanges, () => false);
}
