'use client';

import { m } from 'motion/react';
import type { ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * Scroll-triggered arrival fade, shared by the landing page's narrative
 * sections — the ONE piece of motion a block gets when it enters the viewport.
 *
 * Opacity only, 200ms, since the 2026-08-16 Linear pass. It was a 700ms
 * blur(10px) + 22px drift, and it sat on top of a scroll-linked dissolve on
 * every section wrapper; both were removed together so the reader owns the
 * scroll and content is present when the viewport arrives. Two things follow
 * from "opacity only": the fade never puts a transform on an ancestor (the
 * future section's `background-attachment: fixed` glow needs that), and there
 * is nothing here to shorten for reduced motion — it is skipped outright.
 *
 * `motion/react` is the project's import path for Motion (v12) — never
 * `framer-motion`, which is the old package name for the same library and would
 * install a second copy.
 *
 * `m`, not `motion`: `motion.*` statically pulls in every feature the library
 * has, so one import of it re-inflates the bundle for the whole page. The
 * `LazyMotion features={domAnimation} strict` provider in LandingExperience.tsx
 * supplies what these components need (animations + gestures, which is where
 * `whileInView` lives). `strict` is what keeps this honest — a `motion.*`
 * component rendered under it throws rather than quietly costing 25 kB.
 *
 * Reduced motion renders the final frame immediately rather than a faster
 * animation: a fade-in is decorative, so the correct accommodation is to skip
 * it entirely, not to speed it up.
 */

interface RevealProps {
  children: ReactNode;
  /** Stagger index. Each step adds 60ms, capped so long lists never crawl. */
  index?: number;
  className?: string;
}

/** The fade itself. ≤200ms is the budget: long enough to read as arrival,
 *  short enough that a reader who scrolls straight through never waits. */
const FADE_S = 0.2;
const STEP_MS = 60;
const MAX_STEPS = 6;

export function Reveal({ children, index = 0, className }: RevealProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <m.div
      className={className}
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{
        duration: FADE_S,
        ease: 'easeOut',
        delay: (Math.min(index, MAX_STEPS) * STEP_MS) / 1000,
      }}
    >
      {children}
    </m.div>
  );
}
