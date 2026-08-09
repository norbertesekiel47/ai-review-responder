'use client';

import { m, useScroll, useTransform } from 'motion/react';
import { type ReactNode, useRef } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { SCROLL_CHAPTERS } from './section-map';

/**
 * Scroll-linked handoff between sections.
 *
 * Wraps a section (never modifies it) and ties its opacity, vertical drift and
 * a hair of scale to its own progress through the viewport, so leaving one
 * section and arriving at the next reads as a single dissolve-with-depth
 * rather than two unrelated events. `Reveal` already animates a section's
 * ARRIVAL once; this is the part that was missing — the departure, and the
 * overlap between the two. It also renders the vertical chapter marker for the
 * sections that carry one (see `SCROLL_CHAPTERS`) — inside the wrapper, so the
 * marker dissolves with its own section and the boundary reads as one chapter
 * stamp handing off to the next.
 *
 * The wrapper also carries the `id` and the snap point, which is why sections
 * did not need to change: the scroll behaviour lives entirely out here.
 *
 * ── Why `transform` is optional ───────────────────────────────────────────
 * `background-attachment: fixed` resolves against the viewport ONLY while no
 * ancestor has a transform — a transformed ancestor silently downgrades it to
 * `scroll`. The future section's card glow is built on exactly that (see
 * future.css), so it is wrapped with `transform={false}`: it still dissolves,
 * it just does not drift. Anything else built on fixed attachment needs the
 * same treatment. Opacity alone is safe — it creates a stacking context, not a
 * containing block.
 *
 * Reduced motion renders a plain wrapper: a continuous scroll-linked fade is
 * decorative, so the correct accommodation is to remove it, not to shorten it.
 * The id and the snap point survive, so the rail and the snapping still work.
 */

interface SectionTransitionProps {
  id: string;
  children: ReactNode;
  /** Set false for sections containing `background-attachment: fixed`. */
  transform?: boolean;
}

/** How far the section drifts as it enters and leaves, in px. Deliberately
 *  small — this reads as weight, not as travel. */
const DRIFT = 34;

/** Floor of the fade. Not 0: sections sit on their own backgrounds, and taking
 *  them to zero punches a hole to the page ink mid-scroll, which reads as a
 *  flash rather than a dissolve. */
const DIM = 0.35;

/** Floor of the recede. The third channel of the handoff: a section leaving
 *  settles back a breath as it dims, so the incoming one reads as arriving in
 *  FRONT of it — depth, where drift alone is only travel. 0.982 is the whole
 *  budget: at the seam (progress ≈ 0.73 for both neighbours) it interpolates
 *  to ≈ 0.994, under 6px of edge reveal per side at 1920px, felt rather than
 *  seen. Push it lower and the ink behind the section reads as a border. */
const RECEDE = 0.982;

export function SectionTransition({ id, children, transform = true }: SectionTransitionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  // `start end` = section top meets viewport bottom, `end start` = section
  // bottom meets viewport top. For a full-viewport section that is two
  // viewport-heights of travel, so 0.5 is "exactly filling the screen".
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });

  // The plateau is deliberately NARROW (0.42-0.58), and that is the whole
  // tuning. Snap parks a section at exactly 0.5, so it only needs to be fully
  // opaque in a small band around rest — every frame outside that band is
  // mid-transition and should be dissolving.
  //
  // A wide plateau was the first attempt and it failed the point of the
  // feature: at [0, 0.26, 0.74, 1] the halfway moment between two sections
  // measured 0.97 and 0.92, i.e. no visible handoff at all — the fade only
  // arrived once a section was already three-quarters off screen. Here the
  // same moment lands both sections near 0.73, which reads as a cross-dissolve
  // instead of two independent fades.
  const opacity = useTransform(scrollYProgress, [0, 0.42, 0.58, 1], [DIM, 1, 1, DIM]);
  const y = useTransform(scrollYProgress, [0, 0.42, 0.58, 1], [DRIFT, 0, 0, -DRIFT]);
  const scale = useTransform(scrollYProgress, [0, 0.42, 0.58, 1], [RECEDE, 1, 1, RECEDE]);

  // ALWAYS an m.div, even under reduced motion where it animates nothing, and
  // ALWAYS the same element type across every branch.
  //
  // This looks like it could be an early `return <div>` for the reduced-motion
  // case — Reveal does exactly that — and it must not be. `usePrefersReducedMotion`
  // resolves to `false` on the first render and flips to `true` after mount, so
  // branching on the ELEMENT swaps `m.div` for `div` and React replaces the
  // DOM node. ChapterRail's IntersectionObserver captured the originals on mount
  // and would then be watching detached nodes: the rail silently freezes on the
  // first chapter, for reduced-motion users only.
  //
  // The same trap applies to the `motion` -> `m` migration itself: `m.div` and
  // `motion.div` are DIFFERENT component types, so rendering one on the reduced
  // -motion branch and the other elsewhere would reintroduce the identical bug
  // through a different door. One element type, chosen once, for every branch.
  //
  // Keeping one element type keeps node identity stable. What the preference
  // changes is the style, not the tree.
  const style = prefersReducedMotion ? undefined : transform ? { opacity, y, scale } : { opacity };

  // The chapter marker rides in the WRAPPER, not the section: it belongs to
  // the scroll experience (it fades and recedes with the handoff for free,
  // which IS the boundary cue), and the sections stay untouched — the same
  // additive contract as the id and the snap point. `aria-hidden` because it
  // duplicates wayfinding the rail already provides accessibly.
  const chapter = SCROLL_CHAPTERS.find((entry) => entry.id === id);

  return (
    <m.div ref={ref} id={id} className="rw-lp-chapter" style={style}>
      {chapter?.marker ? (
        <div className="rw-lp-chapter-marker" data-tone={chapter.marker.tone} aria-hidden="true">
          <span className="rw-lp-chapter-marker-index">{chapter.marker.index}</span>
          <span className="rw-lp-chapter-marker-rule" />
          <span className="rw-lp-chapter-marker-label">{chapter.label}</span>
        </div>
      ) : null}
      {children}
    </m.div>
  );
}
