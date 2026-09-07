'use client';

import type { RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from '@/hooks/useReveal';

// Illustrative refusals. Lane and category names follow the owner-facing
// vocabulary of the Restraint tab (docs/context/refusal-ledger.md).
const REFUSAL_ROWS = [
  { time: 'Tue 09:14', lane: 'Draft held for you', category: 'Owner review required' },
  { time: 'Tue 11:02', lane: 'Ask withheld', category: 'Wrong moment' },
  { time: 'Wed 16:40', lane: 'Auto-post held', category: 'Watchdog unavailable' },
  { time: 'Thu 08:05', lane: 'Draft held for you', category: 'Unsafe content' },
] as const;

const RESTRAINT_FACTS = [
  'Every refusal timestamped at the moment of the decision, not discovered later',
  'Eight plain reasons, from “unsafe content” to “wrong moment” to “no permission”',
  'Covers drafts, auto-posts, asks, batches, and autonomy pauses in one list',
];

export function FeatRestraint({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [ledgerRef, ledgerSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-restraint"
      aria-label="Restraint: what the system declined to do"
      className="rw-dl-band is-paper is-tight"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-split">
          <FeatIntro
            n="08"
            kicker="Restraint · what it declined"
            bar="var(--rw-ink2)"
            group="Measure"
            title="It also shows you what it decided not to do."
            lede="The Restraint tab lists what RepWorth decided not to do, and when: a draft held for you, an auto-post held back, an ask withheld, a batch halted, autonomy paused. Each entry carries its reason in plain words, so every time the system stopped is on the record next to every time it acted."
          >
            <ul className="rw-dl-bul">
              {RESTRAINT_FACTS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </FeatIntro>
          <div ref={ledgerRef} className={cn('feat-ch-ar rw-dl-rv', ledgerSeen && 'is-in')}>
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot is-bar" style={{ ['--bar' as string]: 'var(--rw-ink2)' }} />
                <span>Restraint · sample week</span>
                <span className="rw-dl-cap-tail">4 refusals</span>
              </div>
              <div className="feat-ledger">
                {REFUSAL_ROWS.map((r) => (
                  <div key={`${r.time}-${r.lane}`} className="feat-ledger-row">
                    <span className="feat-ledger-time">{r.time}</span>
                    <span className="feat-ledger-x">{r.lane}</span>
                    <span className="feat-ledger-verdict is-reason">
                      <i aria-hidden="true" />
                      {r.category}
                    </span>
                  </div>
                ))}
              </div>
              <p className="rw-dl-fine">Illustrative entries. Your tab lists your own refusals, newest first, with the reason each was recorded.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
