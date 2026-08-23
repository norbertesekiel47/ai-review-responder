'use client';

import { type CSSProperties, type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { FeatReceipt } from './FeatPrimitives';
import { useReveal } from './useReveal';

// The brief's headline counts (sample week).
const BRIEF_COUNTS = [
  ['Reviews', '14'],
  ['Responded', '13'],
  ['Rate', '93%'],
] as const;

// Mirrors the digest's real sections: this-week volume vs the trailing 4-week
// average, and the "needs your eye" lane (lowest-rated reviews of the week).
const BRIEF_ROWS = [
  { topic: 'New reviews this week', count: '14', width: 88, bar: 'var(--rw-sage-bar)' },
  { topic: '4-week average', count: '11', width: 69, bar: 'var(--rw-sage-bar)' },
  { topic: 'Needs your eye (≤2★)', count: '2', width: 13, bar: 'var(--rw-blush-bar)' },
];

const BRIEF_LIST = [
  'Review volume and trend',
  'A plain-language brief with one concrete suggestion',
  'Estimated time saved this week',
  'Reviews that need your eye',
  'How you compare with a competitor you name',
];

/* ================== 03 INSIGHTS (flipped chapter: brief left, text right) ================== */
export function FeatInsights({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-insights"
      aria-label="Insights: the weekly brief"
      className="rw-dl-band"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-flip">
          <FeatIntro
            n="03"
            kicker="Insights · every Monday"
            bar="var(--rw-teal-bar)"
            group="Your agent team"
            title="A brief you'll actually read."
            lede="Insights is the reporting agent. It sends a short, plain-language summary of what customers said this week: what they loved, what they complained about, and, when there is enough to say, one thing worth looking at on the ops side."
          >
            <ul className="rw-dl-bul">
              {BRIEF_LIST.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </FeatIntro>

          <div ref={cardRef} className={cn('feat-ch-ar rw-dl-rv', cardSeen && 'is-in')}>
            <article className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot" />
                <span>Weekly brief · sample · Your Business</span>
                <span className="rw-dl-cap-tail">Issue 18 · Apr 14–20</span>
              </div>

              <FeatReceipt cells={BRIEF_COUNTS} className="feat-brief-rec" />

              <p className="feat-brief-lbl">This week at a glance</p>
              <div className="feat-brief-rows">
                {BRIEF_ROWS.map((m, i) => (
                  <div key={m.topic} className="feat-brief-row">
                    <span className="feat-brief-dot" style={{ ['--bar' as string]: m.bar }} />
                    <span className="feat-brief-topic">{m.topic}</span>
                    <span className="feat-brief-track">
                      <span
                        className="rw-brief-bar-fill"
                        style={
                          {
                            // Unitless ratio, not a percentage: the bar reveals
                            // via scaleX (see .rw-brief-bar-fill), and scaleX
                            // takes a number.
                            '--fill-r': m.width / 100,
                            '--fill-d': `${400 + i * 150}ms`,
                            '--bar': m.bar,
                          } as CSSProperties
                        }
                      />
                    </span>
                    <span className="feat-brief-count">{m.count}</span>
                  </div>
                ))}
              </div>

              <div className="rw-dl-quote feat-brief-quote">
                <div className="rw-dl-quote-meta">One thing to look at</div>
                &ldquo;Wait time came up in 4 reviews this week. Worth a look at how pickups are
                staffed on your busiest days.&rdquo;
              </div>
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}
