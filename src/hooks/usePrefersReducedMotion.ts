'use client';

import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the user's OS "reduce motion" preference.
 *
 * SSR-safe and defensive: returns `false` until mounted and in any environment
 * without `window.matchMedia` (SSR, older jsdom), then updates live if the
 * setting changes. Use this to short-circuit JS-driven animations (typewriters,
 * rAF loops, intervals, parallax) to their final/static frame — CSS
 * `@media (prefers-reduced-motion)` only governs CSS animations, not JS ones.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(QUERY);
    setReduced(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
