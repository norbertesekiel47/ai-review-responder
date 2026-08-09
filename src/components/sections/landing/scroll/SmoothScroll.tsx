'use client';

import Lenis from 'lenis';
import Snap from 'lenis/snap';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { SCROLL_CHAPTERS } from './section-map';
import 'lenis/dist/lenis.css';

/**
 * Smoothed scrolling + eased snap for the landing page.
 *
 * Native CSS `scroll-snap-type: y proximity` places the snap points correctly
 * but the LANDING is the browser's own correction animation — abrupt, uneased,
 * and with no CSS knob to tune it. That is the clunk. Lenis replaces the input
 * side (wheel deltas -> lerped scroll position) and its Snap module replaces
 * the landing with an animation we own the duration and easing of.
 *
 * Lenis here scrolls the real window (`wrapper: window`, the default) — it is
 * NOT a transform-based fake scroller. That matters twice: `position: fixed`
 * chrome (nav, rail, motion toggle) keeps working untouched, and the future
 * section's `background-attachment: fixed` card glow keeps resolving against
 * the viewport, which a transformed scroll container would silently break.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * Active under exactly the conditions the CSS snap block in
 * scroll-experience.css declares — ≥901px wide AND ≥700px tall — and never
 * under `prefers-reduced-motion`. The bounds are the snap bounds for the same
 * reasons (below them sections overflow and snapping fights the reader), and
 * reduced motion gets native, un-smoothed scrolling because inertial easing is
 * exactly the kind of decorative motion the preference asks to remove.
 *
 * While a Lenis instance is alive it stamps `lenis` on <html>; the CSS snap
 * rule is scoped `:not(.lenis)`, so native snap stands back in automatically
 * whenever this provider is gated off (reduced motion, small viewports, a
 * destroyed instance, JS disabled). The two mechanisms never run together —
 * native snap correcting a position Lenis is still animating is a tug of war.
 *
 * ── Why the chapters are re-registered rather than shared ─────────────────
 * Snap points come from `SCROLL_CHAPTERS`, the same single owner the rail and
 * the section wrappers read, so a section cannot be scrollable-to without also
 * being a snap target. `ignoreTransform: true` is load-bearing: the chapter
 * wrappers carry a scroll-linked drift/scale transform (SectionTransition),
 * and the default `getBoundingClientRect()` measurement would bake whatever
 * mid-transition offset the wrapper happened to have into the snap position.
 * `offsetTop` reads the layout position, which is where the section actually
 * rests.
 */

const LenisContext = createContext<Lenis | null>(null);

/** The live Lenis instance, or null when gated off (small viewport, reduced
 *  motion, SSR). Consumers must keep a native fallback for the null case. */
export function useLenis(): Lenis | null {
  return useContext(LenisContext);
}

/** Mirrors the CSS snap gate in scroll-experience.css — the two must move
 *  together, or one mechanism runs where the other was tuned to. */
const ACTIVE_MEDIA = '(min-width: 901px) and (min-height: 700px)';
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Same curve family as the rail-jump scroll (ease-out expo): fast departure,
 *  long soft landing — the landing is the part native snap gets wrong. */
const SNAP_EASING = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

export function SmoothScrollProvider({ children }: { children: ReactNode }) {
  const [lenis, setLenis] = useState<Lenis | null>(null);

  useEffect(() => {
    const active = window.matchMedia(ACTIVE_MEDIA);
    const reduced = window.matchMedia(REDUCED_MOTION);

    let instance: Lenis | null = null;
    let snap: Snap | null = null;

    const teardown = () => {
      snap?.destroy();
      snap = null;
      // destroy() also removes the `lenis` class from <html>, which is what
      // hands snapping back to the CSS rule.
      instance?.destroy();
      instance = null;
      setLenis(null);
    };

    const sync = () => {
      const shouldRun = active.matches && !reduced.matches;
      if (shouldRun && !instance) {
        // Defaults on purpose: `lerp: 0.1` is the feel this page wants, and
        // `smoothWheel` only touches wheel input — touch stays native, so
        // trackpads-with-touch semantics and mobile are never hijacked.
        instance = new Lenis({ autoRaf: true });

        snap = new Snap(instance, {
          // `proximity`, NEVER `mandatory` — same law as the CSS block: it
          // assists a scroll that already ended near a boundary and lets a
          // fast flick cross several sections. `mandatory` turns a seven-
          // screen page into seven separate gestures.
          type: 'proximity',
          // 35% of the viewport, not the 50% default. Sections sit exactly one
          // viewport apart, so at 50% EVERY rest position is within range of
          // some snap point and proximity degenerates into mandatory. 35%
          // leaves a dead band in the middle of each crossing — and lets a
          // reader parked inside a section that overflows its viewport (the
          // personas grid at 1100×800) stay where they stopped.
          distanceThreshold: '35%',
          debounce: 350,
          duration: 1.05,
          easing: SNAP_EASING,
        });

        for (const chapter of SCROLL_CHAPTERS) {
          const element = document.getElementById(chapter.id);
          // `start`, matching the `scroll-snap-align: start` it replaces.
          if (element) snap.addElement(element, { align: 'start', ignoreTransform: true });
        }

        setLenis(instance);
      } else if (!shouldRun && instance) {
        teardown();
      }
    };

    sync();
    // Both preferences can change mid-session (window resize past 901px, OS
    // motion setting toggled); the instance follows rather than requiring a
    // reload.
    active.addEventListener('change', sync);
    reduced.addEventListener('change', sync);
    return () => {
      active.removeEventListener('change', sync);
      reduced.removeEventListener('change', sync);
      teardown();
    };
  }, []);

  return <LenisContext.Provider value={lenis}>{children}</LenisContext.Provider>;
}
