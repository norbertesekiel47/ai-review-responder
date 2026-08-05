'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { Reveal } from '../reveal';
import {
  CARD_TAG,
  CLOSING_ACCENT,
  CLOSING_LEAD,
  CLOSING_TAIL,
  COMMITTED,
  COMMITTED_HINT,
  COMMITTED_LABEL,
  COMMITTED_NOTE,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  LEAD_IN,
  type FutureAgent,
} from './future-copy';

/**
 * Where RepWorth is going.
 *
 * Two columns: the argument on the left (heading, lead, and the closing line
 * that reframes the roadmap), the committed work on the right as a 2x2 of flip
 * cards. The split exists because the single-column version left roughly a
 * third of the row empty at 16:9 while the card bodies were wrapping to four
 * lines.
 *
 * Only committed direction appears here — the exploring tier was cut. The rule
 * that survives is that a card must never make an unbuilt thing look shipped,
 * which is now carried by three things at once: the tier disclaimer, the
 * dashed card edge, and the `Planned` tag on every card FRONT. That last one
 * matters more than it looks: the flip hides the body, and the body is where
 * all the future-tense "will" lives. See future-copy.ts.
 */

function FutureCard({ agent }: { agent: FutureAgent }) {
  const [flipped, setFlipped] = useState(false);
  const toggle = useCallback(() => setFlipped((value) => !value), []);

  return (
    <li className="rw-lp-future-card">
      {/*
        A real <button>, for the same reason AgentFlipCard is one: a hover-only
        flip hides the body from every touch device and every keyboard user.
        Pointer gets :hover, touch toggles `flipped`, keyboard gets
        :focus-visible plus Enter/Space. Both faces stay in the DOM and neither
        is aria-hidden, so a screen reader reads name then body in order.
      */}
      <button
        type="button"
        className="rw-lp-future-flip"
        data-flipped={flipped ? 'true' : 'false'}
        aria-pressed={flipped}
        onClick={toggle}
      >
        <span className="rw-lp-future-flip-inner">
          <span className="rw-lp-future-flip-face rw-lp-future-flip-front">
            <span className="rw-lp-future-card-tag">{CARD_TAG}</span>
            <span className="rw-lp-future-card-name">{agent.name}</span>
          </span>

          <span className="rw-lp-future-flip-face rw-lp-future-flip-back">
            <span className="rw-lp-future-card-back-name">{agent.name}</span>
            <span className="rw-lp-future-card-body">{agent.body}</span>
          </span>
        </span>
      </button>
    </li>
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
            <Reveal>
              <header className="rw-lp-future-intro">
                <p className="rw-lp-future-eyebrow">{EYEBROW}</p>
                <h2 className="rw-lp-future-heading" id="rw-lp-future-heading">
                  {HEADING_LEAD}{' '}
                  <span className="rw-lp-future-heading-accent">{HEADING_ACCENT}</span>
                </h2>
                <p className="rw-lp-future-lead">{LEAD_IN}</p>
              </header>
            </Reveal>

            <Reveal index={1}>
              <figure className="rw-lp-future-closing">
                <blockquote className="rw-lp-future-closing-quote">
                  {CLOSING_LEAD}{' '}
                  <span className="rw-lp-future-closing-accent">{CLOSING_ACCENT}</span>{' '}
                  {CLOSING_TAIL}
                </blockquote>
              </figure>
            </Reveal>
          </div>

          <div className="rw-lp-future-committed">
            <Reveal index={1}>
              <div className="rw-lp-future-tier-head">
                <h3 className="rw-lp-future-tier-label">{COMMITTED_LABEL}</h3>
                <p className="rw-lp-future-tier-note">{COMMITTED_NOTE}</p>
                <p className="rw-lp-future-tier-hint">{COMMITTED_HINT}</p>
              </div>
            </Reveal>

            <Reveal index={2}>
              <ul className="rw-lp-future-grid">
                {COMMITTED.map((agent) => (
                  <FutureCard key={agent.id} agent={agent} />
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
