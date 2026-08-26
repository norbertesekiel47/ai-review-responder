'use client';

import Image from 'next/image';
import { m } from 'motion/react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { AmbientVideo } from '../ambient-motion';
import { Staged, StagedLine } from '../staged';
import {
  BODY_PARAGRAPHS,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  HEADING_PLAIN,
  PIVOT_ACCENT,
  PIVOT_LEAD,
} from './problem-copy';

/**
 * The problem — kinetic essay + the reputation diagram (v0.2, owner-directed
 * 2026-08-24).
 *
 * The essay holds the LEFT; the RIGHT carries the section's one visual: an
 * ambient diagram of the customer-side reputation — a café orbited by what a
 * customer finds (stars, a review, a reply, and one dark card: the silence).
 * The diagram is decorative and claim-free (see problem-copy.ts for its
 * binding rules); the copy carries the meaning, so the clip is `aria-hidden`
 * and reduced motion renders its still.
 *
 * The text still performs: heading lines, paragraphs and the pivot enter as
 * staged beats (motion-driven and finite — the hero-entrance pattern, immune
 * to the CSS pause rule), and the pivot lands last behind a drawn gold rule.
 * The clip itself rides `AmbientVideo`, so the footer's pause control governs
 * it like every other looping clip on the page.
 *
 * The pivot is the section's exit: it hands the reader to "Meet the fleet"
 * directly below, which is why it carries the accent and sits last in the
 * grid at every width (grid areas — the diagram slots between body and pivot
 * on one column, beside them on two).
 */

const EASE: [number, number, number, number] = [0.22, 0.61, 0.36, 1];

const DIAGRAM_VIDEO = '/problem/problem-diagram.mp4';
const DIAGRAM_POSTER = '/problem/problem-diagram.jpg';

export function ProblemSection() {
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <section className="rw-lp-problem" aria-labelledby="rw-lp-problem-heading">
      <div className="rw-lp-problem-inner">
        <div className="rw-lp-problem-copy">
          <Staged beat={0}>
            <p className="rw-lp-problem-eyebrow">{EYEBROW}</p>
          </Staged>

          {/* The visible heading is two staged lines; the aria-label carries
              the flat sentence so assistive tech is never handed the split. */}
          <h2
            className="rw-lp-problem-heading"
            id="rw-lp-problem-heading"
            aria-label={HEADING_PLAIN}
          >
            <StagedLine beat={1} className="rw-lp-problem-heading-line">
              {HEADING_LEAD}
            </StagedLine>
            <StagedLine beat={2} className="rw-lp-problem-heading-line rw-lp-problem-heading-accent">
              {HEADING_ACCENT}
            </StagedLine>
          </h2>

          <div className="rw-lp-problem-body">
            {BODY_PARAGRAPHS.map((paragraph, index) => (
              <Staged key={paragraph.slice(0, 24)} beat={3 + index}>
                <p>{paragraph}</p>
              </Staged>
            ))}
          </div>
        </div>

        {/* The reputation diagram. Decorative — `aria-hidden` on the wrapper
            covers the reduced-motion still as well as the clip (the flip-card
            pattern). AmbientVideo keeps it under the footer's pause control. */}
        <Staged beat={2} className="rw-lp-problem-figure-slot">
          <div className="rw-lp-problem-figure" aria-hidden="true">
            {prefersReducedMotion ? (
              <Image
                src={DIAGRAM_POSTER}
                alt=""
                fill
                sizes="(max-width: 960px) 92vw, 34rem"
                className="rw-lp-problem-figure-media"
              />
            ) : (
              <AmbientVideo
                className="rw-lp-problem-figure-media"
                src={DIAGRAM_VIDEO}
                poster={DIAGRAM_POSTER}
                preload="none"
                tabIndex={-1}
              />
            )}
          </div>
        </Staged>

        {/* The finale: a gold rule draws itself in, then the pivot lands. */}
        <div className="rw-lp-problem-pivot-block">
          <m.span
            className="rw-lp-problem-pivot-rule"
            aria-hidden="true"
            initial={prefersReducedMotion ? false : { scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={
              prefersReducedMotion ? { duration: 0 } : { duration: 0.8, ease: EASE, delay: 0.45 }
            }
          />
          <p className="rw-lp-problem-pivot">
            <StagedLine beat={5}>{PIVOT_LEAD}</StagedLine>{' '}
            <StagedLine beat={6} className="rw-lp-problem-pivot-accent">
              {PIVOT_ACCENT}
            </StagedLine>
          </p>
        </div>
      </div>
    </section>
  );
}
