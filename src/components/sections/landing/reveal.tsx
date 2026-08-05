'use client';

import { m } from 'motion/react';
import type { ReactNode } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

/**
 * Scroll-triggered blur-in reveal, shared by the landing page's narrative
 * sections.
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
 * animation: a blur-in is decorative, so the correct accommodation is to skip
 * it entirely, not to speed it up.
 */

interface RevealProps {
  children: ReactNode;
  /** Stagger index. Each step adds 80ms, capped so long lists never crawl. */
  index?: number;
  className?: string;
}

const STEP_MS = 80;
const MAX_STEPS = 6;

export function Reveal({ children, index = 0, className }: RevealProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <m.div
      className={className}
      initial={{ filter: 'blur(10px)', opacity: 0, y: 22 }}
      whileInView={{ filter: 'blur(0px)', opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{
        duration: 0.7,
        ease: [0.4, 0, 0.2, 1],
        delay: (Math.min(index, MAX_STEPS) * STEP_MS) / 1000,
      }}
    >
      {children}
    </m.div>
  );
}
