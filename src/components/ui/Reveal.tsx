'use client';

import { type ReactNode } from 'react';
import { useReveal } from '@/hooks/useReveal';

/**
 * Scroll reveal on the shared `.rw-dl-rv` primitive (island.css).
 *
 * The trigger lives in `useReveal` — this component owns only the wrapper
 * element and the scroll-linked opt-in.
 */
export function Reveal({
  children,
  delay = 0,
  scrub = false,
}: {
  children: ReactNode;
  /** Stagger, in ms, applied after the element crosses the trigger line. */
  delay?: number;
  /**
   * Opt into the scroll-linked entrance (island.css Layer 2). Where
   * `animation-timeline` is unsupported the class is inert and the one-shot
   * entrance below runs instead, so this is always safe to set.
   *
   * Leave it off for text: scrubbing a paragraph's opacity against scroll
   * makes it unreadable mid-range. It earns its place on artifacts that are
   * already visual — charts, ledgers, card grids.
   */
  scrub?: boolean;
}) {
  const [ref, seen] = useReveal<HTMLDivElement>({ delay });
  return (
    <div ref={ref} className={`rw-dl-rv ${scrub ? 'is-scrub ' : ''}${seen ? 'is-in' : ''}`}>
      {children}
    </div>
  );
}
