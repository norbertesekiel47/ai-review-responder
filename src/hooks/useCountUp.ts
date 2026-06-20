'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

export interface CountUpOptions {
  /** While false, the value stays at 0; the animation (re)starts when it flips true. Default true. */
  active?: boolean;
  /** Animation duration in ms. Default 900. */
  duration?: number;
  /** Delay before the count begins, in ms. Default 0. */
  delayMs?: number;
  /** Emit integers (rounded) instead of floats. Default false. */
  round?: boolean;
}

/**
 * Animates a number from 0 to `target` over `duration` ms using a cubic
 * ease-out curve, emitting the current value on each rAF tick.
 *
 * Consolidates the dashboard KPI counter with the marketing-section counters;
 * `active` gates the animation on visibility, `delayMs`/`round` cover the
 * section variants. (Section delay is measured from the first frame rather than
 * effect setup — a sub-frame difference from the former inline copies.)
 */
export function useCountUp(target: number, options: CountUpOptions = {}): number {
  const { active = true, duration = 900, delayMs = 0, round = false } = options;
  const [value, setValue] = useState(0);
  const startRef = useRef<number | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    // Reduced motion: no rAF loop — the final value is derived in the return
    // below, so there's no setState here (avoids set-state-in-effect).
    if (!active || prefersReducedMotion) return;
    let raf = 0;
    startRef.current = null;
    const step = (t: number) => {
      if (startRef.current == null) startRef.current = t + delayMs;
      const progress = Math.max(0, Math.min(1, (t - startRef.current) / duration));
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = target * eased;
      setValue(round ? Math.round(next) : next);
      if (progress < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, active, delayMs, round, prefersReducedMotion]);

  // Reduced motion → show the final value immediately (derived, not animated).
  if (prefersReducedMotion) return round ? Math.round(target) : target;
  return value;
}
