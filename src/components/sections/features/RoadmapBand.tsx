'use client';

import type { RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { ReviewStars } from './FeatPrimitives';
import { useReveal } from '@/hooks/useReveal';

// Illustrative scorecard for an unreleased feature ("Coming soon" / preview).
// Competitors are anonymized placeholders, not real businesses.
const COMPETITOR_ROWS = [
  { rank: '#1', name: 'You', stars: '4.8', resp: '96% responded', highlighted: true },
  { rank: '#2', name: 'Competitor A', stars: '4.4', resp: 'Sample data' },
  { rank: '#3', name: 'Competitor B', stars: '4.2', resp: 'Sample data' },
  { rank: '#4', name: 'Competitor C', stars: '4.0', resp: 'Sample data' },
];

/* ================== ROADMAP (split chapter: text left, scorecard right) ================== */
export function RoadmapBand({ innerRef }: { innerRef?: RefObject<HTMLElement | null> }) {
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-roadmap"
      aria-label="What the agent takes on next"
      className="rw-dl-band is-paper is-open"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-split">
          <FeatIntro
            kicker="What's next · Coming soon"
            bar="var(--rw-sage-bar)"
            group="Roadmap"
            title="The same fleet, reaching further."
            lede="Today RepWorth answers, requests, briefs, and measures on Google. The roster below is what the fleet takes on next, previewed here as the neighborhood scorecard, drawn with sample data."
          >
            <p className="feat-roadmap-roster">
              Flag fakes · Watch everywhere · Compare with competitors · Dispute the fake one-star
            </p>
          </FeatIntro>

          <div ref={cardRef} className={cn('feat-ch-ar rw-dl-rv', cardSeen && 'is-in')}>
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
                        <ReviewStars rating={Number(r.stars)} glyphs="★" /> {r.stars} · {r.resp}
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
