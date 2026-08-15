'use client';

import { useState, type RefObject } from 'react';
import { useReveal } from './useReveal';

const AI_REPLIES = {
  before: {
    label: 'Generic reply',
    meta: 'Template · no personalization',
    borderColor: 'rgba(242,195,185,0.6)',
    text: '"Thank you for your feedback! We appreciate your business and hope to see you again soon."',
    diag: [
      ['Written from scratch', 'No'],
      ['References detail', 'No'],
      ['Invites return', 'Generic'],
    ],
  },
  after: {
    label: 'Your response',
    meta: 'Personalized · in your voice',
    borderColor: 'rgba(151,179,174,0.35)',
    text: `"Thank you so much! We're thrilled the al pastor tacos hit the spot. Our team makes the achiote marinade from scratch every morning. Looking forward to your next visit!"`,
    diag: [
      ['Written from scratch', 'Yes'],
      ['References detail', 'Al pastor · achiote'],
      ['Invites return', 'Next visit'],
    ],
  },
} as const;

/* ================== 01 REPLY ================== */
export function FeatReply({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [tab, setTab] = useState<'before' | 'after'>('after');
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();

  const r = AI_REPLIES[tab];

  return (
    <section ref={innerRef} id="f-reply" aria-label="Reply: the drafting agent" className="px-8 md:px-16 py-20 relative">
      <div ref={headRef} className={`rw-reveal flex items-start gap-6 mb-10 ${headSeen ? 'in' : ''}`}>
        <span className="rw-num-tag text-7xl leading-none text-rw-teal/40" aria-hidden="true">01</span>
        <div className="flex-1">
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Reply · your drafter</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight max-w-xl">
            Every reply written from scratch, <span className="rw-display-serif text-rw-teal-strong">never</span> from a template.
          </h2>
          <p className="text-rw-ink-soft mt-4 max-w-xl leading-relaxed">
            Reply is the drafting agent. It reads the actual review, references the specifics the
            customer mentioned, and writes in a voice that sounds like you wrote it yourself. No
            &ldquo;thanks for your feedback&rdquo; filler.
          </p>
        </div>
      </div>

      <div ref={cardRef} className={`rw-reveal bg-rw-cream/60 rounded-3xl p-6 md:p-10 border border-rw-teal/10 ${cardSeen ? 'in' : ''}`}>
        <div className="flex items-center gap-2 mb-6">
          <button
            type="button"
            onClick={() => setTab('before')}
            aria-pressed={tab === 'before'}
            className={`rw-label-mono text-xs uppercase tracking-wider px-3 py-1.5 rounded-full border border-rw-ink/20 transition-all ${
              tab === 'before' ? 'bg-rw-ink text-white shadow-md -translate-y-0.5' : 'text-rw-ink-soft hover:text-rw-ink'
            }`}
          >
            Generic reply
          </button>
          <svg className="size-4 text-rw-teal-strong" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
          </svg>
          <button
            type="button"
            onClick={() => setTab('after')}
            aria-pressed={tab === 'after'}
            className={`rw-label-mono text-xs uppercase tracking-wider px-3 py-1.5 rounded-full border border-rw-ink/20 transition-all ${
              tab === 'after' ? 'bg-rw-ink text-white shadow-md -translate-y-0.5' : 'text-rw-ink-soft hover:text-rw-ink'
            }`}
          >
            RepWorth reply
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-6 items-start">
          {/* Review card */}
          <div className="bg-white rounded-2xl p-6 border border-rw-teal/10 shadow-sm">
            <div className="flex items-center gap-3 mb-3">
              <div
                className="size-10 rounded-full"
                style={{ background: 'linear-gradient(135deg, #F2C3B9, #D6CBBF)' }}
                aria-hidden
              />
              <div>
                <p className="text-sm font-medium text-rw-ink">Sample reviewer</p>
                <div className="flex gap-0.5" aria-label="5 out of 5 stars">
                  <span className="text-rw-teal" aria-hidden="true">★★★★★</span>
                </div>
              </div>
              <span className="ml-auto text-xs rw-label-mono text-rw-ink-soft">2h ago · Google</span>
            </div>
            <p className="text-[15px] text-rw-ink leading-relaxed">
              &ldquo;The al pastor tacos were incredible; the achiote marinade had this perfect
              smoky-sweet balance. Will be back next weekend!&rdquo;
            </p>
          </div>

          {/* Response card */}
          <div
            className="bg-white rounded-2xl p-6 border-2 shadow-sm"
            style={{ borderColor: r.borderColor, transition: 'border-color 0.5s ease' }}
          >
            <div className="flex items-center justify-between mb-4">
              <p className="rw-label-mono text-xs uppercase text-rw-teal-strong">{r.label}</p>
              <p className="text-xs rw-label-mono text-rw-ink-soft">{r.meta}</p>
            </div>
            <p className="text-[15px] text-rw-ink leading-relaxed">{r.text}</p>
            <div className="mt-5 pt-5 border-t border-rw-teal/10 grid grid-cols-3 gap-3 text-xs">
              {r.diag.map(([k, v]) => (
                <div key={k}>
                  <p className="rw-label-mono text-rw-ink-soft mb-1">{k}</p>
                  <p className="text-rw-ink font-medium">{v}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
