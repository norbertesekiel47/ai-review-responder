'use client';

import { type CSSProperties, type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { FeatReceipt } from './FeatPrimitives';
import { useReveal } from '@/hooks/useReveal';

// Sample counts; every card says so. The section names on the monthly card
// are the real ones from the monthly-impact email template.
const BRIEF_COUNTS = [
  ['Reviews', '14'],
  ['Responded', '13'],
  ['Rate', '93%'],
] as const;

const BRIEF_ROWS = [
  { topic: 'New reviews this week', count: '14', width: 88, bar: 'var(--rw-sage-bar)' },
  { topic: '4-week average', count: '11', width: 69, bar: 'var(--rw-sage-bar)' },
  { topic: 'Needs your eye (≤2★)', count: '2', width: 13, bar: 'var(--rw-blush-bar)' },
];

const BRIEF_LIST = [
  'Review volume and trend, with what needs your eye',
  'A plain-language brief with one concrete suggestion',
  'Estimated time saved this week',
  'A monthly impact report: the month’s brief, best review, time saved',
  'The same Intelligence Brief on your dashboard, any day of the week',
];

const MONTHLY_COUNTS = [
  ['Reviews', '58'],
  ['Responded', '56'],
  ['Time saved', '6.5 h'],
] as const;

const MONTHLY_SECTIONS = [
  { title: 'Monthly Intelligence Brief', sub: 'What customers praised, what they complained about, and one operational suggestion.' },
  { title: 'Best Review of the Month', sub: 'The review worth pinning by the register, with the reply that went out.' },
  { title: 'Estimated time saved', sub: 'Handled reviews, multiplied by the minutes a reply used to cost you.' },
] as const;

export function FeatInsights({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-insights"
      aria-label="Insights: the weekly brief and the monthly report"
      className="rw-dl-band is-tight"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-wide">
          <FeatIntro
            n="06"
            kicker="Insights · every Monday"
            bar="var(--rw-teal-bar)"
            group="Brief"
            title="A brief you can read in a minute."
            lede="Insights is the reporting agent. Every Monday it sends a short, plain-language summary of what customers said this week: what they loved, what they complained about, and, when there is enough to say, one thing worth looking at on the ops side. Once a month it closes the books with an impact report. Both arrive by email; neither needs a login."
          >
            <ul className="rw-dl-bul">
              {BRIEF_LIST.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </FeatIntro>
          <div ref={cardRef} className={cn('feat-ch-ar feat-two rw-dl-rv', cardSeen && 'is-in')}>
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
            <article className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot" />
                <span>Monthly impact report · sample · Your Business</span>
                <span className="rw-dl-cap-tail">April</span>
              </div>
              <FeatReceipt cells={MONTHLY_COUNTS} className="feat-brief-rec" />
              <p className="feat-brief-lbl">Inside the report</p>
              <div className="feat-monthly-sections">
                {MONTHLY_SECTIONS.map((s) => (
                  <div key={s.title} className="feat-monthly-section">
                    <p className="feat-monthly-t">{s.title}</p>
                    <p className="feat-monthly-s">{s.sub}</p>
                  </div>
                ))}
              </div>
              <p className="rw-dl-fine">Sample figures. The report is built from your own month, or not sent at all.</p>
            </article>
          </div>
        </div>
      </div>
    </section>
  );
}
