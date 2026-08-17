'use client';

import type { RefObject } from 'react';
import { useReveal } from './useReveal';

const VERDICT_ROWS = [
  { time: 'Mon 10:41', excerpt: '"Thank you so much! We\'re thrilled…"', verdict: 'pass' as const },
  { time: 'Mon 12:03', excerpt: '"So glad the mole landed, see you…"', verdict: 'pass' as const },
  { time: 'Tue 09:17', excerpt: '"We appreciate the shout-out about…"', verdict: 'pass' as const },
  { time: 'Tue 14:52', excerpt: '"Glad Saturday worked out, the…"', verdict: 'flag' as const },
];

/* ================== 06 WATCHDOGS ================== */
export function FeatWatchdogs({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [headRef, headSeen] = useReveal<HTMLDivElement>();
  const [ledgerRef, ledgerSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-watchdogs"
      aria-label="Judge and Governor: oversight"
      className="px-8 md:px-16 py-20 bg-rw-ink text-white relative overflow-hidden"
    >
      <div
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.6) 1px, transparent 1.5px)',
          backgroundSize: '3px 3px',
        }}
        aria-hidden
      />
      {/* `min-w-0` on both grid children: without it the nowrap ledger excerpts set the
          implicit column's min-content width (~467px on a 390px phone) and the whole
          chapter is clipped by `overflow-hidden` — heading, body and ledger cut off. */}
      <div className="relative grid md:grid-cols-12 gap-10 items-start">
        <div ref={headRef} className={`rw-reveal min-w-0 md:col-span-5 ${headSeen ? 'in' : ''}`}>
          <span className="rw-num-tag text-7xl leading-none text-white/20 block mb-4" aria-hidden="true">06</span>
          <p className="rw-label-mono text-xs uppercase text-rw-peach mb-3">Judge &amp; Governor · oversight</p>
          <h2 className="text-4xl md:text-5xl font-medium leading-tight mb-4">
            Autonomy that is watched, <span className="rw-display-serif text-rw-peach">always</span>.
          </h2>
          <p className="text-white/70 max-w-md leading-relaxed">
            Every reply that posts without your tap is reviewed by the Judge: a separate AI safety
            check, with its own rulebook, on 100% of Autopilot&apos;s public replies. If the Judge
            is unavailable, auto-posting stops on its own. And if a reply is flagged, or edits and
            vetoes pile up over a week, the Governor pauses Autopilot for your whole account, emails
            you, and RepWorth support switches it back on after a review.
          </p>
        </div>

        <div ref={ledgerRef} className={`rw-reveal min-w-0 md:col-span-7 ${ledgerSeen ? 'in' : ''}`}>
          <div className="rounded-3xl border border-white/15 bg-white/5 p-6">
            <div className="flex items-center justify-between gap-3 mb-4">
              <p className="rw-label-mono text-xs uppercase text-white/60">Judge verdicts · sample week</p>
              <span className="rw-label-mono text-[10px] uppercase text-rw-peach whitespace-nowrap shrink-0">100% of auto-posts</span>
            </div>
            <div className="space-y-2">
              {VERDICT_ROWS.map((r) => (
                <div key={r.time} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5 text-sm">
                  <span className="rw-label-mono text-[10px] text-white/50 w-16 md:w-20 shrink-0">{r.time}</span>
                  <span className="flex-1 min-w-0 text-white/85 truncate">{r.excerpt}</span>
                  <span
                    className={`rw-label-mono text-[10px] uppercase px-2 py-0.5 rounded-full ${
                      r.verdict === 'pass'
                        ? 'bg-rw-teal/25 text-white'
                        : 'bg-rw-peach text-rw-ink'
                    }`}
                  >
                    {r.verdict === 'pass' ? 'Pass' : 'Flagged'}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-white/10 flex items-center gap-3">
              <span className="size-2 rounded-full bg-rw-peach shrink-0" aria-hidden />
              <p className="text-xs text-white/70">
                Flagged verdict → Autopilot is paused for this account and you are notified.
                Replies go back to your approval queue.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
