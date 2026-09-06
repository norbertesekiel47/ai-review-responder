'use client';

import type { RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from '@/hooks/useReveal';

const VERDICT_ROWS = [
  { time: 'Mon 10:41', excerpt: '"Thank you so much! We\'re thrilled…"', verdict: 'pass' as const },
  { time: 'Mon 12:03', excerpt: '"So glad the mole landed, see you…"', verdict: 'pass' as const },
  { time: 'Tue 09:17', excerpt: '"We appreciate the shout-out about…"', verdict: 'pass' as const },
  { time: 'Tue 14:52', excerpt: '"Glad Saturday worked out, the…"', verdict: 'flag' as const },
];

/* ================== 06 WATCHDOGS (flipped chapter: ledger left, text right) ================== */
export function FeatWatchdogs({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [ledgerRef, ledgerSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-watchdogs"
      aria-label="Judge and Governor: oversight"
      className="rw-dl-band is-paper is-tight"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-flip">
          <FeatIntro
            n="13"
            kicker="Judge & Governor · oversight"
            bar="var(--rw-ink2)"
            group="Govern"
            title="Two watchdogs check every reply that posts itself."
            lede="The Judge reviews every reply that posts without your tap, all 100% of them. It is a separate AI safety check with its own rulebook. If the Judge is unavailable, auto-posting stops on its own. The Governor watches the pattern instead. If a reply is flagged, or edits and vetoes pile up over a week, the Governor pauses Autopilot for your whole account and emails you. RepWorth support switches it back on after a review."
          />

          <div ref={ledgerRef} className={cn('feat-ch-ar rw-dl-rv', ledgerSeen && 'is-in')}>
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot is-bar" style={{ ['--bar' as string]: 'var(--rw-ink2)' }} />
                <span>Judge verdicts · sample week</span>
                <span className="rw-dl-cap-tail">100% of auto-posts</span>
              </div>
              <div className="feat-ledger">
                {VERDICT_ROWS.map((r) => (
                  <div key={r.time} className="feat-ledger-row">
                    <span className="feat-ledger-time">{r.time}</span>
                    <span className="feat-ledger-x">{r.excerpt}</span>
                    <span className={cn('feat-ledger-verdict', r.verdict === 'flag' && 'is-flag')}>
                      <i aria-hidden="true" />
                      {r.verdict === 'pass' ? 'Pass' : 'Flagged'}
                    </span>
                  </div>
                ))}
              </div>
              <p className="rw-dl-fine">
                Flagged verdict → Autopilot is paused for this account and you are notified. Replies
                go back to your approval queue.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
