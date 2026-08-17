'use client';

import type { RefObject } from 'react';
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
    <section ref={innerRef} id="f-roadmap" aria-label="What the agent takes on next" className="px-8 md:px-16 py-20 bg-rw-cream/40 relative">
      <div className="grid md:grid-cols-12 gap-10 items-center">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-6 ${leftSeen ? 'in' : ''}`}>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <p className="rw-label-mono text-xs uppercase text-rw-teal-strong">What&apos;s next</p>
            <span className="inline-block w-px h-4 bg-rw-teal/30" />
            <p className="rw-label-mono text-xs uppercase text-rw-ink-soft">Coming soon</p>
          </div>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight mb-5">
            The same agent, <span className="rw-display-serif text-rw-teal-strong">reaching</span> further.
          </h2>
          <p className="rw-label-mono text-sm uppercase tracking-wider text-rw-teal-strong mb-4">
            Get reviews · Flag fakes · Watch everywhere · Compare with competitors
          </p>
          <p className="text-rw-ink-soft max-w-md leading-relaxed">
            Today RepWorth minds your Google reviews. The roster above is what the agent takes on
            next, previewed here as the neighborhood scorecard, drawn with sample data.
          </p>
        </div>

        <div ref={rightRef} className={`rw-reveal from-right md:col-span-6 ${rightSeen ? 'in' : ''}`}>
          <div className="bg-white rounded-3xl p-6 border border-rw-teal/15 shadow-lg relative overflow-hidden">
            <span className="absolute top-4 right-4 rw-label-mono text-[10px] uppercase text-rw-peach bg-rw-peach/15 px-2 py-1 rounded-full border border-rw-peach/40">
              preview
            </span>
            <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-4">
              Neighborhood scorecard · sample data
            </p>
            <div className="space-y-3">
              {COMPETITOR_ROWS.map((r, i) => (
                <div
                  key={r.name}
                  className={`rw-comp-row flex items-center gap-3 p-3 rounded-2xl ${
                    r.highlighted ? 'bg-rw-teal/10 border border-rw-teal/30' : ''
                  }`}
                  style={{ ['--cr-d' as string]: `${120 + i * 140}ms` }}
                >
                  <span className={`rw-num-tag text-2xl w-8 ${r.highlighted ? 'text-rw-ink' : 'text-rw-ink-soft'}`}>
                    {r.rank}
                  </span>
                  <div className="flex-1">
                    <p className={`text-sm ${r.highlighted ? 'font-medium text-rw-ink' : 'text-rw-ink'}`}>
                      {r.name}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-rw-ink-soft">
                      <span aria-label={`${r.stars} out of 5 stars`}>
                        <span aria-hidden="true">★</span> {r.stars}
                      </span>
                      <span>·</span>
                      <span>{r.resp}</span>
                    </div>
                  </div>
                  {r.highlighted && (
                    <svg className="size-4 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
