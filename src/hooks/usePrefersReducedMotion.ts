'use client';

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Tracks the user's OS "reduce motion" preference.
 *
 * Implemented with `useSyncExternalStore` so it is SSR-safe (server snapshot is
 * `false`), updates live when the setting changes, and never calls setState from
 * an effect. Defensive against environments without `window.matchMedia`.
 *
 * Use to short-circuit JS-driven animations (typewriters, rAF loops, intervals,
 * parallax) to their final/static frame — CSS `@media (prefers-reduced-motion)`
 * only governs CSS animations, not JS ones.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
