'use client';

import Link from 'next/link';
import { BrandClip } from '../brand-clip';
import { STATEMENT_ACCENT, STATEMENT_FOOTNOTE, STATEMENT_LEAD, WATCHDOGS } from './watchdogs-copy';

/**
 * Section 6 — the agents that watch. Judge and Governor copy on the left; the
 * paired original CRTs inside the arched scene on the right. The scene owns
 * `overflow: hidden`, so the clips cannot protrude through its curved corners.
 * This section is the page's door to /how-it-works.
 */
export function WatchdogsSection() {
  return (
    <div className="rw-lp-synthesis-model">
      <section className="rw-lp-syn-m-watch" aria-labelledby="rw-lp-watch-heading">
        <div className="rw-lp-syn-m-inner rw-lp-syn-m-watch-grid">
          <div>
            <p className="rw-lp-syn-m-label">The agents that watch</p>
            <h2 id="rw-lp-watch-heading">Care needs<em>oversight, too.</em></h2>
            {WATCHDOGS.map((agent) => <article key={agent.id}><h3>{agent.name}</h3><p>{agent.body}</p><strong>{agent.rule}</strong></article>)}
            <Link href="/how-it-works" className="rw-lp-syn-m-text-link">See how a review moves through the fleet <span aria-hidden="true">↗</span></Link>
          </div>
          <div className="rw-lp-syn-m-watch-scene">
            <div className="rw-lp-syn-m-watch-machines"><BrandClip id="judge" /><BrandClip id="governor" /></div>
            <blockquote>{STATEMENT_LEAD}<em>{STATEMENT_ACCENT}</em></blockquote>
            <p>{STATEMENT_FOOTNOTE}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
