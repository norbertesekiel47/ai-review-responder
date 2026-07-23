'use client';

import { type RefObject } from 'react';
import { useReveal } from './useReveal';

const APPROVAL_STEPS = [
  { n: '01', title: 'New review lands', sub: 'New review detected via webhook', t: '0:00', dark: false, d: '100ms' },
  { n: '02', title: 'AI drafts a reply in your voice', sub: 'Uses past approvals as style reference', t: '+0:12', dark: false, d: '300ms' },
  { n: '03', title: 'You get a message on your channel', sub: 'Email, Telegram, or WhatsApp: review + draft + three buttons', t: '+0:15', dark: false, d: '500ms' },
  { n: '04', title: 'You tap approve · we post it', sub: 'Median owner time: 28 seconds · No login required', t: '+0:58', dark: true, d: '700ms' },
];

/* ================== 04 THE GATE ================== */
export function FeatGate({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [tlRef, tlSeen] = useReveal<HTMLDivElement>();
  const [phoneRef, phoneSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-gate"
      aria-label="The gate: Copilot approval"
      className="px-8 md:px-16 py-20 relative"
    >
      <div ref={headRef} className={`rw-reveal flex items-start gap-6 mb-12 ${headSeen ? 'in' : ''}`}>
        <span className="rw-num-tag text-7xl leading-none text-rw-beige" aria-hidden="true">04</span>
        <div className="flex-1">
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Copilot · your control</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight max-w-2xl">
            Every reply needs your <span className="rw-display-serif text-rw-teal-strong">sign-off</span>.
          </h2>
          <p className="text-rw-ink-soft mt-4 max-w-xl leading-relaxed">
            On Copilot, every draft comes to you on the channel you choose: email, Telegram, or
            WhatsApp, with the review and the reply side-by-side. Tap approve, edit inline, or ask
            for a fresh draft. Nothing is posted without your go-ahead.
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-12 gap-10 items-center">
        <div ref={tlRef} className={`rw-reveal md:col-span-7 ${tlSeen ? 'in' : ''}`}>
          <ol className="space-y-4">
            {APPROVAL_STEPS.map((s) => (
              <li
                key={s.n}
                className="rw-t-step flex gap-4 items-start"
                style={{ ['--step-d' as string]: s.d }}
              >
                <div
                  className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center rw-label-mono text-sm ${
                    s.dark ? 'bg-rw-ink text-white' : 'bg-rw-teal/15 text-rw-teal-strong'
                  }`}
                >
                  {s.n}
                </div>
                <div
                  className={`flex-1 rounded-2xl p-4 border ${
                    s.dark
                      ? 'bg-rw-ink text-white border-rw-ink'
                      : 'bg-white text-rw-ink border-rw-teal/15'
                  }`}
                >
                  <p className="text-sm font-medium">{s.title}</p>
                  <p className={`text-xs mt-0.5 ${s.dark ? 'opacity-80' : 'text-rw-ink-soft'}`}>{s.sub}</p>
                </div>
                <span className="rw-label-mono text-xs text-rw-ink-soft self-center">{s.t}</span>
              </li>
            ))}
          </ol>
        </div>

        <div ref={phoneRef} className={`rw-reveal scale-in md:col-span-5 flex justify-center ${phoneSeen ? 'in' : ''}`}>
          <div className="rw-phone-float relative w-[260px]" style={{ transform: 'rotate(-2deg)' }}>
            <div className="relative rounded-[2.5rem] p-[3px]" style={{ background: 'linear-gradient(135deg,#222,#444)' }}>
              <div className="rounded-[2.3rem] bg-rw-cream overflow-hidden">
                <div className="px-5 pt-3 pb-2 flex justify-between items-center text-[11px] rw-label-mono text-rw-ink">
                  <span>9:41</span>
                  <div className="w-20 h-5 rounded-full bg-rw-ink" />
                  <span>·</span>
                </div>
                <div className="p-4 space-y-3">
                  <div className="rw-phone-item bg-white rounded-xl p-3 shadow-sm" style={{ ['--pi-d' as string]: '400ms' }}>
                    <p className="rw-label-mono text-[10px] uppercase text-rw-teal-strong mb-1">New review</p>
                    <p className="text-[11px] text-rw-ink-soft">
                      <span aria-label="5 out of 5 stars">
                        <span aria-hidden="true">★★★★★</span>
                      </span>
                      {' · Sample reviewer'}
                    </p>
                    <p className="text-[12px] text-rw-ink mt-1 leading-snug">
                      &ldquo;Al pastor tacos were incredible, the achiote marinade…&rdquo;
                    </p>
                  </div>
                  <div
                    className="rw-phone-item rounded-xl p-3 border border-rw-teal/25"
                    style={{ ['--pi-d' as string]: '650ms', background: 'rgba(151,179,174,0.10)' }}
                  >
                    <p className="rw-label-mono text-[10px] uppercase text-rw-teal-strong mb-1">Draft reply</p>
                    <p className="text-[12px] text-rw-ink leading-snug">
                      &ldquo;Thank you so much! We&apos;re thrilled the al pastor…&rdquo;
                    </p>
                  </div>
                  <div
                    className="rw-phone-item w-full bg-rw-ink text-white py-2.5 rounded-full text-[12px] font-medium flex items-center justify-center gap-1.5"
                    style={{ ['--pi-d' as string]: '900ms' }}
                  >
                    <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    Approve &amp; post
                  </div>
                  <div className="rw-phone-item grid grid-cols-2 gap-2" style={{ ['--pi-d' as string]: '1100ms' }}>
                    <div className="py-2 rounded-full text-[11px] border border-rw-teal/30 text-rw-ink-soft text-center">
                      Edit
                    </div>
                    <div className="py-2 rounded-full text-[11px] border border-rw-teal/30 text-rw-ink-soft text-center">
                      Regenerate
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
