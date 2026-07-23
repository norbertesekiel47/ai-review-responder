'use client';

import type { RefObject } from 'react';
import { useReveal } from './useReveal';

const GUARDIAN_STEPS = [
  { n: '01', title: '1★ review lands', sub: 'Negative lane: Guardian reads it first', t: '0:00', dark: false, d: '100ms' },
  { n: '02', title: 'Severity read', sub: 'Routine · elevated · critical: a bounded AI check', t: '+0:01', dark: false, d: '300ms' },
  { n: '03', title: 'Critical → escalation', sub: "You're notified with the full context", t: '+0:02', dark: false, d: '500ms' },
  { n: '04', title: 'You acknowledge and resolve', sub: 'Tracked until discharged · never auto-posted', t: 'ongoing', dark: true, d: '700ms' },
];

/* ================== 02 GUARDIAN ================== */
export function FeatGuardian({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [tlRef, tlSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-guardian"
      aria-label="Guardian: negative-review triage"
      className="px-8 md:px-16 py-20 bg-gradient-to-b from-white to-rw-cream/50 relative"
    >
      <div ref={headRef} className={`rw-reveal flex items-start gap-6 mb-12 ${headSeen ? 'in' : ''}`}>
        <span className="rw-num-tag text-7xl leading-none text-rw-peach/80" aria-hidden="true">02</span>
        <div className="flex-1">
          <p className="rw-label-mono text-xs uppercase text-rw-teal-strong mb-3">Guardian · the negative lane</p>
          <h2 className="text-4xl md:text-5xl font-medium text-rw-ink leading-tight max-w-2xl">
            Bad reviews get read <span className="rw-display-serif text-rw-teal-strong">first</span>, not just answered.
          </h2>
          <p className="text-rw-ink-soft mt-4 max-w-xl leading-relaxed">
            Guardian triages every negative review by severity before anything is drafted. Routine
            gripes flow on to drafting; serious ones (health claims, legal threats, review-bombing)
            escalate straight to you with the context attached. Guardian never posts anything, anywhere.
          </p>
        </div>
      </div>

      <div ref={tlRef} className={`rw-reveal max-w-2xl ${tlSeen ? 'in' : ''}`}>
        <ol className="space-y-4">
          {GUARDIAN_STEPS.map((s) => (
            <li key={s.n} className="rw-t-step flex gap-4 items-start" style={{ ['--step-d' as string]: s.d }}>
              <div
                className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center rw-label-mono text-sm ${
                  s.dark ? 'bg-rw-ink text-white' : 'bg-rw-peach/25 text-rw-teal-strong'
                }`}
              >
                {s.n}
              </div>
              <div
                className={`flex-1 rounded-2xl p-4 border ${
                  s.dark ? 'bg-rw-ink text-white border-rw-ink' : 'bg-white text-rw-ink border-rw-teal/15'
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
    </section>
  );
}
