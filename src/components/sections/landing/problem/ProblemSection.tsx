'use client';

import { Reveal } from '../reveal';
import {
  BODY_PARAGRAPHS,
  EYEBROW,
  HEADING_ACCENT,
  HEADING_LEAD,
  PIVOT_ACCENT,
  PIVOT_LEAD,
} from './problem-copy';

/**
 * The problem — section 6.
 *
 * Deliberately the quietest section on the page: no glass, no cards, no
 * media. Between the hero's film and the fleet's diagram, this is the one
 * purely typographic beat — an essay opening, not a feature block. The
 * restraint is the design: the page earns its diagrams by first stating, in
 * prose, what they are for.
 *
 * The pivot line is the section's exit — it hands the reader to "Meet the
 * fleet" directly below, which is why it carries the accent and sits last.
 */
export function ProblemSection() {
  return (
    <section className="rw-lp-problem" aria-labelledby="rw-lp-problem-heading">
      <div className="rw-lp-problem-inner">
        <Reveal>
          <header>
            <p className="rw-lp-problem-eyebrow">{EYEBROW}</p>
            <h2 className="rw-lp-problem-heading" id="rw-lp-problem-heading">
              {HEADING_LEAD}{' '}
              <span className="rw-lp-problem-heading-accent">{HEADING_ACCENT}</span>
            </h2>
          </header>
        </Reveal>

        <Reveal index={1}>
          <div className="rw-lp-problem-body">
            {BODY_PARAGRAPHS.map((paragraph) => (
              <p key={paragraph.slice(0, 24)}>{paragraph}</p>
            ))}
          </div>
        </Reveal>

        <Reveal index={2}>
          <p className="rw-lp-problem-pivot">
            {PIVOT_LEAD} <span className="rw-lp-problem-pivot-accent">{PIVOT_ACCENT}</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
