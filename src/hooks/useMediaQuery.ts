'use client';

import { useCallback, useSyncExternalStore } from 'react';

const alwaysFalse = () => false;
const noopUnsubscribe = () => {};

/**
 * Tracks a CSS media query as DERIVED state.
 *
 * Implemented with `useSyncExternalStore` rather than `useState` + an effect,
 * for the same reasons as `usePrefersReducedMotion`: it is SSR-safe (the server
 * snapshot is always `false`), it updates live, and it never calls setState
 * from an effect body — which `react-hooks/set-state-in-effect` rejects.
 *
 * The `false` server snapshot means any layout gated on this hook renders in
 * its "no match" form during SSR and hydration, then switches. Gate on the
 * query that makes the SSR fallback the SAFE one: prefer
 * `useMediaQuery('(min-width: 901px)')` for progressive enhancement over
 * `(max-width: 900px)` for progressive degradation, unless the mobile layout
 * is genuinely the fallback you want served first.
 *
 * Defensive against environments without `window.matchMedia` (jsdom without
 * the polyfill, older embedded webviews).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return noopUnsubscribe;
      }
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  }, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, alwaysFalse);
}
