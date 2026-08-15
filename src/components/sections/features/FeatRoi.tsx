'use client';

import { type RefObject } from 'react';
import { useReveal } from './useReveal';

/* ================== 09 ROI ================== */
export function FeatRoi({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [gridRef, gridSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-roi"
      aria-label="ROI dashboard"
      className="px-8 md:px-16 py-20 bg-rw-cream/50 relative"
    >
      <div ref={headRef} className={`rw-reveal flex items-start gap-6 mb-10 ${headSeen ? 'in' : ''}`}>
        <span className="rw-num-tag text-7xl leading-none text-rw-beige">09</span>
        <div className="flex-1 max-w-2xl">
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Proof</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight">
            Numbers to show your <span className="rw-display-serif text-rw-teal-strong">accountant</span>.
          </h2>
          <p className="text-rw-ink-soft mt-4 leading-relaxed">
            Response rate before and after. Your average rating over time. Where you sit in local
            search. The kind of numbers that justify the line item.
          </p>
          <p className="text-[10px] italic text-rw-ink-soft mt-2">
            Sample dashboard with illustrative numbers — yours shows your own.
          </p>
        </div>
      </div>

      <div ref={gridRef} className={`rw-reveal grid md:grid-cols-12 gap-6 ${gridSeen ? 'in' : ''}`}>
        <div className="md:col-span-4 bg-white rounded-3xl p-6 border border-rw-teal/15">
          <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-4">Response rate</p>
          <div className="flex items-baseline gap-3">
            <span className="rw-num-tag text-lg line-through text-rw-ink-soft/60">12%</span>
            <svg className="size-4 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
            </svg>
            <span className="rw-num-tag text-4xl text-rw-ink">96<span className="text-lg">%</span></span>
          </div>
          <div className="mt-4 h-8 relative">
            <div className="absolute inset-0 bg-rw-teal-strong/15 rounded-full" />
            <div className="absolute inset-y-0 left-0 right-[4%] bg-rw-teal-strong rounded-full" />
          </div>
        </div>

        <div className="md:col-span-4 bg-white rounded-3xl p-6 border border-rw-teal/15">
          <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-4">Avg rating</p>
          <div className="flex items-baseline gap-3">
            <span className="rw-num-tag text-lg line-through text-rw-ink-soft/60">4.1</span>
            <svg className="size-4 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
            </svg>
            <span className="rw-num-tag text-4xl text-rw-ink">4.6<span className="text-lg">★</span></span>
          </div>
          <svg className="mt-4 w-full h-8" viewBox="0 0 200 32" preserveAspectRatio="none" aria-hidden>
            <path
              d="M0,28 L30,27 L60,24 L90,21 L120,16 L150,11 L180,7 L200,5"
              stroke="#97B3AE"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="200" cy="5" r="3" fill="#97B3AE" />
          </svg>
        </div>

        <div className="md:col-span-4 bg-white rounded-3xl p-6 border border-rw-teal/15">
          <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-4">Local map rank</p>
          <div className="flex items-baseline gap-3">
            <span className="rw-num-tag text-lg line-through text-rw-ink-soft/60">#14</span>
            <svg className="size-4 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
            </svg>
            <span className="rw-num-tag text-4xl text-rw-ink">#3</span>
          </div>
          <svg className="mt-4 w-full h-8" viewBox="0 0 200 32" preserveAspectRatio="none" aria-hidden>
            <path
              d="M0,28 L30,26 L60,22 L90,20 L120,14 L150,10 L180,6 L200,4"
              stroke="#97B3AE"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="200" cy="4" r="3" fill="#97B3AE" />
          </svg>
        </div>

        <div className="md:col-span-12 bg-rw-ink text-white rounded-3xl p-8 relative overflow-hidden">
          <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
            <div>
              <p className="rw-label-mono text-xs uppercase text-rw-peach mb-2">Google map position · sample</p>
              <p className="rw-display-serif text-2xl">Watch where you stand in the neighborhood.</p>
            </div>
            <div className="text-right">
              <p className="rw-label-mono text-[10px] text-white/50">SEARCH: &ldquo;taqueria near me&rdquo;</p>
              <p className="rw-label-mono text-[10px] text-white/50">RADIUS: 2mi</p>
            </div>
          </div>
          <div className="relative h-36">
            <svg className="w-full h-full" viewBox="0 0 800 144" preserveAspectRatio="none" aria-hidden>
              <line x1="0" y1="36" x2="800" y2="36" stroke="rgba(255,255,255,0.1)" />
              <line x1="0" y1="72" x2="800" y2="72" stroke="rgba(255,255,255,0.1)" />
              <line x1="0" y1="108" x2="800" y2="108" stroke="rgba(255,255,255,0.1)" />
              <path
                d="M0,124 L80,118 L160,110 L240,92 L320,84 L400,74 L480,60 L560,46 L640,38 L720,30 L800,24 L800,144 L0,144 Z"
                fill="rgba(242,195,185,0.15)"
              />
              <path
                className="rw-sparkline-path"
                d="M0,124 L80,118 L160,110 L240,92 L320,84 L400,74 L480,60 L560,46 L640,38 L720,30 L800,24"
                stroke="#F2C3B9"
                strokeWidth="2.5"
                fill="none"
                strokeLinecap="round"
              />
              <circle cx="800" cy="24" r="5" fill="#F2C3B9" />
              <circle cx="800" cy="24" r="10" fill="#F2C3B9" opacity="0.25" />
            </svg>
            <div className="absolute left-0 top-0 rw-label-mono text-[10px] text-white/50">#1</div>
            <div className="absolute left-0 bottom-0 rw-label-mono text-[10px] text-white/50">#20</div>
          </div>
          <div className="flex justify-between mt-3 rw-label-mono text-[10px] text-white/40">
            <span>Jan</span>
            <span>Feb</span>
            <span>Mar</span>
          </div>
        </div>
      </div>
    </section>
  );
}
