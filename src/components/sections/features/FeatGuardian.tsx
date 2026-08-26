'use client';

import type { RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { FeatSteps, type FeatStep } from './FeatPrimitives';
import { useReveal } from '@/hooks/useReveal';

const GUARDIAN_STEPS: readonly FeatStep[] = [
  { n: '01', title: '1★ review lands', sub: 'Guardian reads it before anything is drafted', t: '0:00', final: false },
  { n: '02', title: 'Severity read', sub: 'Low · medium · high: a quick AI check', t: '+0:01', final: false },
  { n: '03', title: 'Serious → escalation', sub: "You're notified with the full context", t: '+0:02', final: false },
  { n: '04', title: 'You acknowledge and resolve', sub: 'Tracked in your dashboard until you mark it resolved · never auto-posted', t: 'ongoing', final: true },
];

/* ================== 02 GUARDIAN (split chapter: text left, timeline right) ================== */
export function FeatGuardian({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [tlRef, tlSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-guardian"
      aria-label="Guardian: negative-review triage"
      className="rw-dl-band is-paper is-tight"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-split">
          <FeatIntro
            n="02"
            kicker="Guardian · reviews of 3★ or less"
            bar="var(--rw-blush-bar)"
            group="Your agent team"
            title="Bad reviews get read first, not just answered."
            lede={
              <>
                Guardian reads every review that isn&apos;t clearly positive and grades its severity
                before anything is drafted. Serious ones (safety or health hazards, legal threats,
                harassment or discrimination allegations, staff-misconduct or fraud accusations) go
                straight to you with the context attached. A careful draft is still prepared, but it
                always waits for you. Guardian never posts anything, anywhere.
              </>
            }
          />

          <div ref={tlRef} className={cn('feat-ch-ar rw-dl-rv', tlSeen && 'is-in')}>
            <FeatSteps steps={GUARDIAN_STEPS} />
          </div>
        </div>
      </div>
    </section>
  );
}
