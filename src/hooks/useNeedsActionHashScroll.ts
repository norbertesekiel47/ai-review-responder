'use client';

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export function useNeedsActionHashScroll(
  reviewsRef: RefObject<HTMLElement | null>,
  onMatch: () => void,
) {
  const onMatchRef = useRef(onMatch);
  // Keep the ref current without re-subscribing the mount effect below. Assigned
  // in an effect, not during render, per react-hooks/refs.
  useEffect(() => {
    onMatchRef.current = onMatch;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash !== '#needs-action') return;

    onMatchRef.current();
    const timeoutId = setTimeout(() => {
      if (reviewsRef.current) {
        const top = reviewsRef.current.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [reviewsRef]);
}
