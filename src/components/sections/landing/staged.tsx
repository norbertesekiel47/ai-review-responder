'use client';

import { m } from 'motion/react';
import type { ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * Staged arrival — the cinematic sibling of `Reveal` (2026-08-24 revamp).
 *
 * `Reveal` remains the quiet default: one ≤200ms opacity fade. `Staged` is the
 * hero-entrance grammar made shareable — a 650ms fade with a 14px rise, beats
 * 110ms apart — for the blocks each section elevates into a performance
 * (the problem essay's lines, the persona dock-in, the watchdog statement).
 *
 * Motion-driven, NOT CSS keyframes, for the same reason the hero entrance is
 * (measurements.md §2 "Hero entrance"): the beats are finite, and the ambient
 * pause rule freezes CSS keyframes only — a finite CSS animation could be
 * stranded mid-flight by the pause control, a motion animation cannot.
 *
 * Reduced motion renders the final frame via `initial={false}` on the SAME
 * element type — never a `div`-vs-`m.div` branch. `SectionTransition` died of
 * that branch (an observer captured the pre-swap node); keeping one element
 * type means nothing can ever observe a stale one.
 *
 * ── `rise=0` ─────────────────────────────────────────────────────────────
 * `rise=0` writes NO transform at all — the beat is opacity only. It existed
 * for the future section's cards, whose `background-attachment: fixed` glow a
 * transformed ANCESTOR silently broke; the cards left with the 2026-09-06
 * route map, so nothing on the page requires it today. It stays for the next
 * fixed-attachment surface: pass it from any wrapper above one.
 */

interface StagedProps {
  children: ReactNode;
  /** Beat index. Each beat adds 110ms — the hero-entrance cadence. */
  beat?: number;
  /** Entry rise in px. `0` writes NO transform at all (future-glow safe). */
  rise?: number;
  className?: string;
}

const BEAT_MS = 110;
const DURATION_S = 0.65;
/** The hero entrance's ease — a soft glide-out, no overshoot. */
const EASE: [number, number, number, number] = [0.22, 0.61, 0.36, 1];
const VIEWPORT = { once: true, amount: 0.3 } as const;

/**
 * The ONE beat contract, shared by both elements — `Staged` and `StagedLine`
 * must never drift apart, so neither declares its own motion props.
 */
function useStagedMotionProps(beat: number, rise: number) {
  const prefersReducedMotion = usePrefersReducedMotion();
  return {
    initial: prefersReducedMotion
      ? (false as const)
      : rise === 0
        ? { opacity: 0 }
        : { opacity: 0, y: rise },
    whileInView: rise === 0 ? { opacity: 1 } : { opacity: 1, y: 0 },
    viewport: VIEWPORT,
    transition: prefersReducedMotion
      ? { duration: 0 }
      : { duration: DURATION_S, ease: EASE, delay: (beat * BEAT_MS) / 1000 },
  };
}

export function Staged({ children, beat = 0, rise = 14, className }: StagedProps) {
  return (
    <m.div className={className} {...useStagedMotionProps(beat, rise)}>
      {children}
    </m.div>
  );
}

/**
 * The inline form, for lines INSIDE a block element (a heading's two lines, a
 * blockquote's halves) — `Staged` wraps children in a div, which is invalid
 * there. Same grammar, same reduced-motion contract, on an `m.span`.
 */
export function StagedLine({ children, beat = 0, rise = 14, className }: StagedProps) {
  return (
    <m.span className={className} {...useStagedMotionProps(beat, rise)}>
      {children}
    </m.span>
  );
}
