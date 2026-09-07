'use client';

import type { RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { FeatReceipt } from './FeatPrimitives';
import { useReveal } from '@/hooks/useReveal';

// Illustrative batch; no names, no addresses. The three decisions mirror the
// real ask vocabulary (send / withhold, with a stated reason).
const BATCH_COUNTS = [
  ['Asks', '24'],
  ['Sending', '19'],
  ['Withheld', '5'],
] as const;

const ASK_ROWS = [
  { who: 'Customer · visited Apr 14', decision: 'Send', reason: 'Consent on file · first ask', send: true },
  { who: 'Customer · visited Apr 12', decision: 'Send', reason: 'Consent on file · first ask', send: true },
  { who: 'Customer · visited Apr 9', decision: 'Withheld', reason: 'Asked three weeks ago', send: false },
  { who: 'Customer · visited Apr 8', decision: 'Withheld', reason: 'Opted out · permanent', send: false },
] as const;

const SOLICITOR_FACTS = [
  'Every ask decided send-or-withhold, with a reason you can read',
  'You approve the batch: exclude, regenerate, or withdraw any single ask',
  'One-click unsubscribe on every email; an opt-out outranks every later upload',
  'Sends from its own address, never from your transactional mail',
];

export function FeatSolicitor({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();
  return (
    <section
      ref={innerRef}
      id="f-solicitor"
      aria-label="Solicitor: review requests in managed batches"
      className="rw-dl-band is-paper is-tight"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-flip">
          <FeatIntro
            n="05"
            kicker="Solicitor · managed batches"
            bar="var(--rw-gold-bar)"
            group="Request"
            title="Asks the customers you served, and never the ones who said no."
            lede="Solicitor is the requesting agent. You upload a visit list and attest the consent. It builds a batch, decides send or withhold for each person with a stated reason, writes each email in your voice, and waits for your approval. Every message carries one-click unsubscribe, and an opt-out is permanent: a later upload never undoes it. Solicitor never posts anything publicly."
          >
            <ul className="rw-dl-bul">
              {SOLICITOR_FACTS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </FeatIntro>
          <div ref={cardRef} className={cn('feat-ch-ar rw-dl-rv', cardSeen && 'is-in')}>
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot is-bar" style={{ ['--bar' as string]: 'var(--rw-gold-bar)' }} />
                <span>Batch · sample · awaiting your approval</span>
                <span className="rw-dl-cap-tail">7 days to approve</span>
              </div>
              <FeatReceipt cells={BATCH_COUNTS} className="feat-rec-flush" />
              <div className="feat-ask-rows">
                {ASK_ROWS.map((r) => (
                  <div key={r.who} className="feat-ask-row">
                    <span className="feat-ask-who">{r.who}</span>
                    <span className="feat-ask-reason">{r.reason}</span>
                    <span className={cn('feat-ask-decision', !r.send && 'is-withheld')}>
                      <i aria-hidden="true" />
                      {r.decision}
                    </span>
                  </div>
                ))}
              </div>
              <div className="rw-dl-acts">
                <span className="rw-dl-btn is-go">Approve batch</span>
                <span className="rw-dl-btn">Halt</span>
              </div>
              <p className="rw-dl-fine">Sample batch. Nothing sends until you approve; one tap halts it, before or during the send.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
