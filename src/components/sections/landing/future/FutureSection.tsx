'use client';

import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { Reveal } from '../reveal';
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
 * Where RepWorth is going.
 *
 * Two columns: the argument on the left (heading, lead, and the closing line
 * that reframes the roadmap), the committed work on the right as a 2x2 of
 * static cards. The split exists because the single-column version left
 * roughly a third of the row empty at 16:9 while the card bodies were wrapping
 * to four lines.
 *
 * Only committed direction appears here — the exploring tier was cut. The rule
 * that survives is that a card must never make an unbuilt thing look shipped,
 * which is carried by three things at once: the tier disclaimer, the dashed
 * card edge, and the `Planned` tag on every card. Until 2026-08-16 these were
 * flip cards and the body — where every future-tense "will" lives — was
 * hidden behind the flip; a roadmap does not need a reveal, so the body is now
 * simply on the card. See future-copy.ts.
 */

function FutureCard({ agent }: { agent: FutureAgent }) {
  return (
    <li className="rw-lp-future-card">
      {/* Static: tag, name, body, all visible. Not a button — there is nothing
          to toggle any more, and a card that is not interactive must not look
          or read as one. */}
      <div className="rw-lp-future-card-face">
        <span className="rw-lp-future-card-tag">{CARD_TAG}</span>
        <h4 className="rw-lp-future-card-name">{agent.name}</h4>
        <p className="rw-lp-future-card-body">{agent.body}</p>
      </div>
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
   *
   * `background-attachment: fixed` also needs NO transformed ancestor. Nothing
   * above this section carries one since the scroll-linked section transforms
   * were removed (2026-08-16); if a transform is ever reintroduced above it,
   * the glow silently downgrades to `scroll` and stops tracking the cursor.
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
