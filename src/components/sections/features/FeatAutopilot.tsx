'use client';

import type { RefObject } from 'react';
import { useReveal } from './useReveal';

const POLICY_CHIPS = [
  { label: 'Rating band', value: '4–5★ only' },
  { label: 'Daily cap', value: '10 / day' },
  { label: 'Veto window', value: '15 min' },
];

/* ================== 05 AUTOPILOT ================== */
export function FeatAutopilot({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-autopilot"
      aria-label="Autopilot — bounded autonomy"
      className="px-8 md:px-16 py-20 relative"
    >
      <div className="grid md:grid-cols-12 gap-10 items-start">
        <div ref={headRef} className={`rw-reveal from-left md:col-span-5 ${headSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-rw-teal/40 block mb-4" aria-hidden="true">05</span>
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Autopilot · bounded autonomy</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight mb-5">
            Hands-off, inside <span className="rw-display-serif text-rw-teal-strong">your</span> rules.
          </h2>
          <p className="text-rw-ink-soft max-w-md leading-relaxed">
            On Autopilot, replies to 4–5★ unflagged reviews can post themselves — but only inside a
            policy you set. You choose the rating band, the daily cap, and a veto window of 15 or 30
            minutes. Until the window closes, the reply is yours to stop with one tap. Negative
            reviews are never auto-posted.
          </p>
        </div>

        <div ref={cardRef} className={`rw-reveal from-right md:col-span-7 ${cardSeen ? 'in' : ''}`}>
          <div className="bg-white rounded-3xl p-6 md:p-8 border border-rw-teal/15 shadow-lg max-w-lg">
            <div className="flex items-center justify-between mb-5">
              <p className="rw-label-mono text-xs uppercase text-rw-teal-strong">Queued auto-post · sample</p>
              <span className="rw-label-mono text-[10px] uppercase text-rw-ink-soft">policy matched</span>
            </div>

            <div className="rounded-2xl p-4 border border-rw-teal/25 mb-5" style={{ background: 'rgba(151,179,174,0.08)' }}>
              <p className="rw-label-mono text-[10px] uppercase text-rw-teal-strong mb-1">Reply · ready to post</p>
              <p className="text-sm text-rw-ink leading-relaxed">
                &ldquo;Thank you so much! We&apos;re thrilled the al pastor tacos hit the spot —
                looking forward to your next visit!&rdquo;
              </p>
            </div>

            <div className="flex items-center gap-5 mb-5">
              <div className="relative size-20 shrink-0" role="img" aria-label="Veto window: 14 minutes 32 seconds remaining">
                <svg viewBox="0 0 80 80" className="size-20 -rotate-90" aria-hidden>
                  <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(151,179,174,0.2)" strokeWidth="6" />
                  <circle
                    cx="40" cy="40" r="34" fill="none" stroke="#557069" strokeWidth="6"
                    strokeLinecap="round" strokeDasharray="213.6" strokeDashoffset="7"
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center rw-label-mono text-sm text-rw-ink">
                  14:32
                </span>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-rw-ink">Posting when the window closes</p>
                <p className="text-xs text-rw-ink-soft mt-0.5">One tap stops it — nothing is final until then</p>
                <span className="mt-2 inline-flex items-center gap-1.5 py-1.5 px-4 rounded-full text-xs border border-rw-teal/30 text-rw-ink-soft select-none">
                  Veto this reply
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 pt-4 border-t border-rw-teal/10">
              {POLICY_CHIPS.map((c) => (
                <div key={c.label}>
                  <p className="rw-label-mono text-[10px] uppercase text-rw-ink-soft mb-1">{c.label}</p>
                  <p className="text-sm font-medium text-rw-ink">{c.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
