'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * The ONE scroll-reveal trigger for the Daylight marketing pages.
 *
 * It used to be two. `useReveal` (features) fired at threshold 0.08 with an
 * -80px bottom margin; `Reveal` (how-it-works, pricing) fired at 0.05 with
 * -50px, and skipped the reduced-motion check entirely. Both ran on the same
 * page, so two identical-looking cards entered at different scroll positions.
 * One hook, one pair of numbers, one reduced-motion path.
 *
 * Pairs with the `.rw-dl-rv` → `.is-in` CSS primitive in island.css, which owns
 * the movement itself (and the no-JS and scroll-linked layers around it).
 */

/** Fraction of the element that must be visible before it counts as revealed. */
const REVEAL_THRESHOLD = 0.08;
/** Pulls the trigger line up off the fold, so a card commits before it lands. */
const REVEAL_ROOT_MARGIN = '0px 0px -80px 0px';

export function useReveal<T extends HTMLElement>({ delay = 0 }: { delay?: number } = {}) {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (seen) return;

    // Reduced motion: skip the IntersectionObserver entrance entirely and render
    // the final (revealed) frame on the next tick. This also guarantees children
    // gated on `.rw-reveal.in` (lang chips, voice bars, comp rows, etc.) become
    // visible. Deferred via setTimeout to avoid a synchronous setState in-effect.
    // The caller's `delay` is deliberately ignored here — a stagger the user
    // asked not to see is just a wait.
    if (prefersReducedMotion) {
      const id = window.setTimeout(() => setSeen(true), 0);
      return () => window.clearTimeout(id);
    }

    const el = ref.current;
    if (!el) return;

    // Already on screen at mount: reveal without waiting for an intersection
    // that will never fire.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      const id = window.setTimeout(() => setSeen(true), delay);
      return () => window.clearTimeout(id);
    }

    let timer = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        io.disconnect();
        timer = window.setTimeout(() => setSeen(true), delay);
      },
      { threshold: REVEAL_THRESHOLD, rootMargin: REVEAL_ROOT_MARGIN },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [seen, delay, prefersReducedMotion]);

  return [ref, seen] as const;
}
