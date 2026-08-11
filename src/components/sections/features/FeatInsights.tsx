'use client';

import { type CSSProperties, type RefObject } from 'react';
import { useReveal } from './useReveal';

const BRIEF_MENTIONS = [
  { topic: 'al pastor tacos', count: '7×', width: 88, tone: 'sage' as const },
  { topic: 'friendly staff', count: '6×', width: 75, tone: 'sage' as const },
  { topic: 'wait time', count: '4×', width: 50, tone: 'peach' as const },
  { topic: 'parking', count: '2×', width: 25, tone: 'peach' as const },
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
      className="px-8 md:px-16 py-20 relative"
    >
      <div className="grid md:grid-cols-12 gap-10 items-start">
        <div ref={leftRef} className={`rw-reveal from-left md:col-span-5 ${leftSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-rw-teal/40 block mb-4" aria-hidden="true">03</span>
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Insights · every Monday</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight mb-5">
            A brief you&apos;ll <span className="rw-display-serif text-rw-teal-strong">actually</span> read.
          </h2>
          <p className="text-rw-ink-soft max-w-md leading-relaxed mb-6">
            Insights is the reporting agent. Not a dashboard, not a chart dump: a short, plain-language
            summary of what customers said this week: what they loved, what they complained about, and
            one thing worth looking at on the ops side.
          </p>
          <ul className="space-y-3 text-sm">
            {[
              'Review volume and trend',
              'One concrete operational suggestion',
            ].map((t) => (
              <li key={t} className="flex items-start gap-3">
                <span className="mt-1.5 size-1.5 rounded-full bg-rw-teal shrink-0" />
                <span className="text-rw-ink">{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div ref={rightRef} className={`rw-reveal from-right md:col-span-7 ${rightSeen ? 'in' : ''}`}>
          <article className="bg-rw-cream rounded-3xl p-8 md:p-10 border border-rw-teal/15 shadow-xl">
            <div className="flex items-start justify-between mb-6 pb-4 border-b border-rw-teal/20">
              <div>
                <p className="rw-label-mono text-xs uppercase text-rw-teal-strong">Weekly brief · sample</p>
                <p className="rw-display-serif text-2xl text-rw-ink mt-1">Your Business</p>
              </div>
              <div className="text-right">
                <p className="rw-label-mono text-[10px] text-rw-ink-soft">ISSUE</p>
                <p className="rw-label-mono text-xs text-rw-ink">18 · Apr 14–20</p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-6">
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-1">Reviews</p>
                <p className="rw-num-tag text-3xl text-rw-ink">14 <span className="text-xs text-rw-teal-strong">↑3</span></p>
              </div>
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-1">Avg stars</p>
                <p className="rw-num-tag text-3xl text-rw-ink">4.6 <span className="text-xs text-rw-teal-strong">↑0.2</span></p>
              </div>
              <div>
                <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-1">Responded</p>
                <p className="rw-num-tag text-3xl text-rw-ink">96<span className="text-lg">%</span></p>
              </div>
            </div>

            <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-3">Top mentions this week</p>
            <div className="space-y-2 mb-6">
              {BRIEF_MENTIONS.map((m, i) => {
                const dot = m.tone === 'sage' ? 'bg-rw-teal' : 'bg-rw-peach';
                const fill = m.tone === 'sage' ? 'bg-rw-teal' : 'bg-rw-peach';
                const track = m.tone === 'sage' ? 'bg-rw-teal/15' : 'bg-rw-peach/20';
                return (
                  <div key={m.topic} className="flex items-center gap-3 text-sm bg-white rounded-xl px-3 py-2">
                    <span className={`w-2 h-2 rounded-full ${dot}`} />
                    <span className="text-rw-ink flex-1">{m.topic}</span>
                    <span className={`w-24 h-1.5 rounded-full overflow-hidden ${track}`}>
                      <span
                        className={`rw-brief-bar-fill ${fill}`}
                        style={
                          {
                            // Unitless ratio, not a percentage: the bar reveals
                            // via scaleX (see .rw-brief-bar-fill), and scaleX
                            // takes a number.
                            '--fill-r': m.width / 100,
                            '--fill-d': `${400 + i * 150}ms`,
                          } as CSSProperties
                        }
                      />
                    </span>
                    <span className="rw-label-mono text-xs text-rw-ink-soft w-8 text-right">{m.count}</span>
                  </div>
                );
              })}
            </div>

            <div className="border-t border-rw-teal/20 pt-5">
              <p className="rw-label-mono text-[10px] uppercase text-rw-teal-strong mb-2">One thing to look at</p>
              <p className="text-rw-ink rw-display-serif text-lg leading-snug">
                &ldquo;Wait time came up in 4 reviews this week; all on Saturday nights. Worth looking at
                7–9pm staffing.&rdquo;
              </p>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
