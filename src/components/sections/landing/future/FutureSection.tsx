'use client';

import Image from 'next/image';
import { m } from 'motion/react';
import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { Staged } from '../staged';
import {
  CARD_TAG,
  CLOSING_ACCENT,
  CLOSING_LEAD,
  CLOSING_TAIL,
  COMMITTED,
  COMMITTED_LABEL,
  COMMITTED_NOTE,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  LEAD_IN,
  type FutureAgent,
} from './future-copy';

/**
 * Where RepWorth is going — "screens not yet on" (2026-08-24 revamp).
 *
 * Two columns: the argument on the left, the committed work on the right as a
 * 2x2 of static cards. Each card now opens with a dark CRT screen — the same
 * set the shipped agents live in, not yet powered — so the closing line's
 * claim ("every new agent joins the same supervised fleet") is what the eye
 * sees before a word is read. The honesty machinery is untouched and still
 * triple-redundant: the tier disclaimer, the dashed card edge, and the
 * `Planned` tag beside every name. An OFF screen cannot read as shipped.
 *
 * ── Motion rules for THIS section (stricter than the page's) ──────────────
 * The card glow is `background-attachment: fixed`; a transformed ANCESTOR
 * silently downgrades it to `scroll`. Therefore:
 *   - the cards enter by OPACITY ONLY (`m.li` with no transform values);
 *   - `Staged` wrappers inside the committed column pass `rise={0}`;
 *   - the LEFT column may rise (its wrappers are never card ancestors).
 * Reintroduce a transform above a card and the glow stops tracking.
 */

function FutureCard({ agent, index }: { agent: FutureAgent; index: number }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  return (
    /* Opacity only — see the section comment. `initial={false}` renders the
       final frame under reduced motion on the same element type. */
    <m.li
      className="rw-lp-future-card"
      initial={prefersReducedMotion ? false : { opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={
        prefersReducedMotion
          ? { duration: 0 }
          : { duration: 0.65, ease: 'easeOut', delay: 0.22 + index * 0.11 }
      }
    >
      <div className="rw-lp-future-card-face">
        {/* The unpowered set: the SAME CRT the shipped agents live in, its
            screen dead — generated from the agent stills' world (2026-08-24;
            asset rules in future-copy.ts). Decorative: the tag, name and body
            carry all the information, so the wrapper is aria-hidden. All four
            cards share one still on purpose — four identical unpowered units,
            waiting to be switched on. */}
        <span className="rw-lp-future-card-screen" aria-hidden="true">
          <Image
            src="/future/off-crt.jpg"
            alt=""
            fill
            sizes="(max-width: 640px) 90vw, 18rem"
            className="rw-lp-future-card-screen-still"
          />
        </span>
        <span className="rw-lp-future-card-tag">{CARD_TAG}</span>
        <h4 className="rw-lp-future-card-name">{agent.name}</h4>
        <p className="rw-lp-future-card-body">{agent.body}</p>
      </div>
    </m.li>
  );
}

export function FutureSection() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  /**
   * Pointer-tracked spotlight.
   *
   * ONE listener for the whole section, not one per card. The glow gradients
   * are `background-attachment: fixed`, so they are positioned in VIEWPORT
   * space — which means every card can share a single pair of coordinates and
   * the highlight still lands under the cursor on whichever card it is over.
   * Four listeners each writing four custom properties on every pointermove is
   * the same picture at four times the cost.
   *
   * rAF-coalesced: pointermove fires far faster than the compositor paints, so
   * without this we would write custom properties several times per frame and
   * invalidate the gradient each time.
   *
   * Skipped entirely under `prefers-reduced-motion` — the glow chases the
   * cursor, which is exactly the kind of movement that preference asks us to
   * drop. The custom properties then keep their off-screen defaults and the
   * cards render with their static edge (see future.css).
   *
   * `background-attachment: fixed` also needs NO transformed ancestor. Nothing
   * above this section carries one since the scroll-linked section transforms
   * were removed (2026-08-16); the 2026-08-24 staged beats keep that promise —
   * every wrapper above a card animates opacity only.
   */
  useEffect(() => {
    if (prefersReducedMotion) return;
    const element = sectionRef.current;
    if (!element) return;

    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const paint = () => {
      frame = 0;
      element.style.setProperty('--rw-lp-glow-x', pointerX.toFixed(1));
      element.style.setProperty('--rw-lp-glow-y', pointerY.toFixed(1));
      element.style.setProperty('--rw-lp-glow-xp', (pointerX / window.innerWidth).toFixed(3));
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (frame === 0) frame = requestAnimationFrame(paint);
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [prefersReducedMotion]);

  return (
    <section ref={sectionRef} className="rw-lp-future" aria-labelledby="rw-lp-future-heading">
      <div className="rw-lp-future-inner">
        <div className="rw-lp-future-layout">
          <div className="rw-lp-future-argument">
            <Staged beat={0}>
              <header className="rw-lp-future-intro">
                <p className="rw-lp-future-eyebrow">{EYEBROW}</p>
                <h2 className="rw-lp-future-heading" id="rw-lp-future-heading">
                  {HEADING_LEAD}{' '}
                  <span className="rw-lp-future-heading-accent">{HEADING_ACCENT}</span>
                </h2>
                <p className="rw-lp-future-lead">{LEAD_IN}</p>
              </header>
            </Staged>

            <Staged beat={2}>
              <figure className="rw-lp-future-closing">
                <blockquote className="rw-lp-future-closing-quote">
                  {CLOSING_LEAD}{' '}
                  <span className="rw-lp-future-closing-accent">{CLOSING_ACCENT}</span>{' '}
                  {CLOSING_TAIL}
                </blockquote>
              </figure>
            </Staged>
          </div>

          <div className="rw-lp-future-committed">
            {/* rise={0}: this wrapper is above the grid in the same column —
                never risk a transform near the glow's ancestry. */}
            <Staged beat={1} rise={0}>
              <div className="rw-lp-future-tier-head">
                <h3 className="rw-lp-future-tier-label">{COMMITTED_LABEL}</h3>
                <p className="rw-lp-future-tier-note">{COMMITTED_NOTE}</p>
              </div>
            </Staged>

            {/* No wrapper on the grid: each card is its own opacity-only
                entrance, so no animated element is ever a card's ancestor. */}
            <ul className="rw-lp-future-grid">
              {COMMITTED.map((agent, index) => (
                <FutureCard key={agent.id} agent={agent} index={index} />
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
