'use client';

import type { RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { useReveal } from './useReveal';

// Illustrative scorecard for an unreleased feature ("Coming soon" / preview).
// Competitors are anonymized placeholders, not real businesses.
const COMPETITOR_ROWS = [
  { rank: '#1', name: 'You', stars: '4.8', resp: '96% responded', highlighted: true },
  { rank: '#2', name: 'Competitor A', stars: '4.4', resp: 'Sample data' },
  { rank: '#3', name: 'Competitor B', stars: '4.2', resp: 'Sample data' },
  { rank: '#4', name: 'Competitor C', stars: '4.0', resp: 'Sample data' },
];

/* ================== ROADMAP ================== */
export function RoadmapBand({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-roadmap"
      aria-label="What the agent takes on next"
      className="rw-dl-band is-paper"
    >
      <div className="rw-dl-col">
        <div className="feat-split">
          <div ref={leftRef} className={cn('rw-dl-rv', leftSeen && 'is-in')}>
            <p className="feat-intro-k feat-intro-k-left">
              <span className="feat-intro-tick" style={{ ['--bar' as string]: 'var(--rw-sage-bar)' }} aria-hidden="true" />
              What&apos;s next · Coming soon
            </p>
            <h2 className="rw-dl-h2">The same agent, reaching further.</h2>
            <p className="feat-roadmap-roster">
              Get reviews · Flag fakes · Watch everywhere · Compare with competitors
            </p>
            <p className="feat-split-lede">
              Today RepWorth minds your Google reviews. The roster above is what the agent takes on
              next, previewed here as the neighborhood scorecard, drawn with sample data.
            </p>
          </div>

          <div ref={rightRef} className={cn('rw-dl-rv', rightSeen && 'is-in')}>
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span>Neighborhood scorecard · sample data</span>
                <span className="rw-dl-cap-tail">
                  <span className="rw-dl-chip feat-preview-chip">preview</span>
                </span>
              </div>
              <div className="feat-comp-rows">
                {COMPETITOR_ROWS.map((r) => (
                  <div key={r.name} className={cn('feat-comp-row', r.highlighted && 'is-you')}>
                    <span className="feat-comp-rank">{r.rank}</span>
                    <div className="feat-comp-body">
                      <p className="feat-comp-name">{r.name}</p>
                      <p className="feat-comp-meta">
                        <span className="rw-dl-stars" aria-label={`${r.stars} out of 5 stars`}>
                          <span aria-hidden="true">★</span>
                        </span>{' '}
                        {r.stars} · {r.resp}
                      </p>
                    </div>
                    {r.highlighted && (
                      <svg className="feat-comp-up" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 10l7-7m0 0l7 7m-7-7v18" />
                      </svg>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
