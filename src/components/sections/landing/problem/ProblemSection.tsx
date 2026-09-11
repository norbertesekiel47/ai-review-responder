'use client';

import { BrandClip } from '../brand-clip';
import { BODY_PARAGRAPHS } from './problem-copy';

/**
 * Section 2 — the problem. A warm paper band: the heading, the tilted house
 * film, and the explanation, set in one row on desktop.
 *
 * The outer `rw-lp-synthesis-model` scope carries the serif/body type roles
 * and tokens this section shares with the watchdogs section.
 */
export function ProblemSection() {
  return (
    <div className="rw-lp-synthesis-model">
      <section className="rw-lp-syn-m-problem" aria-labelledby="rw-lp-problem-heading">
        <div className="rw-lp-syn-m-problem-inner">
          <h2 id="rw-lp-problem-heading">You built a business.<em>The rest came with it.</em></h2>
          <div className="rw-lp-syn-m-house"><BrandClip id="house" /></div>
          <div className="rw-lp-syn-m-problem-copy">{BODY_PARAGRAPHS.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
        </div>
      </section>
    </div>
  );
}
