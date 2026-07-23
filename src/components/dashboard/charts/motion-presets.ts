import type { Transition } from 'motion/react';

/** Tween for path-draw reveals — springs visibly overshoot pathLength. */
export const LINE_REVEAL: Transition = { duration: 0.9, ease: [0.33, 1, 0.68, 1] };

/** Spring for bar entrances (animate y + height from the baseline). */
export const BAR_SPRING: Transition = { type: 'spring', stiffness: 260, damping: 26 };

/** Per-bar entrance stagger, in seconds (multiply by bar index). */
export const BAR_STAGGER_S = 0.045;

/** Per-series line-reveal stagger, in seconds (multiply by series index). */
export const LINE_STAGGER_S = 0.12;

/** Spring for hover/end dot position. */
export const DOT_SPRING: Transition = { type: 'spring', stiffness: 320, damping: 22 };

/**
 * The one reduced-motion gate for charts: every animated mark builds its
 * transition through this, so prefers-reduced-motion collapses the whole
 * system to instant, finished renders. `reduced` comes from the existing
 * usePrefersReducedMotion hook (src/hooks/usePrefersReducedMotion.ts).
 */
export function chartTransition(reduced: boolean, base: Transition, delaySeconds = 0): Transition {
  if (reduced) return { duration: 0 };
  return delaySeconds > 0 ? { ...base, delay: delaySeconds } : base;
}
