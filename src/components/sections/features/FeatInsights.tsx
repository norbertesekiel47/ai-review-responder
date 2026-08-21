'use client';

import { type CSSProperties, type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from './useReveal';

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

/* ================== 03 INSIGHTS ================== */
export function FeatInsights({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [leftRef, leftSeen] = useReveal<HTMLDivElement>();
  const [rightRef, rightSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-insights"
      aria-label="Insights: the weekly brief"
      className="rw-dl-band"
    >
      <div className="rw-dl-col">
        <FeatIntro
          n="03"
          kicker="Insights · every Monday"
          bar="var(--rw-teal-bar)"
          title="A brief you'll actually read."
        />
        <div className="feat-split">
          <div ref={leftRef} className={cn('rw-dl-rv', leftSeen && 'is-in')}>
            <p className="feat-split-lede">
              Insights is the reporting agent. It sends a short, plain-language summary of what
              customers said this week: what they loved, what they complained about, and, when
              there is enough to say, one thing worth looking at on the ops side.
            </p>
            <ul className="rw-dl-bul">
              {BRIEF_LIST.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>

          <div ref={rightRef} className={cn('rw-dl-rv', rightSeen && 'is-in')}>
            <article className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot" />
                <span>Weekly brief · sample · Your Business</span>
                <span className="rw-dl-cap-tail">Issue 18 · Apr 14–20</span>
              </div>

              <div className="rw-dl-rec feat-brief-rec">
                <div>
                  <div className="rw-dl-rec-k">Reviews</div>
                  <div className="rw-dl-rec-v">14</div>
                </div>
                <div>
                  <div className="rw-dl-rec-k">Responded</div>
                  <div className="rw-dl-rec-v">13</div>
                </div>
                <div>
                  <div className="rw-dl-rec-k">Rate</div>
                  <div className="rw-dl-rec-v">93%</div>
                </div>
              </div>

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
