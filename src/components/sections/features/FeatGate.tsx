'use client';

import { type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from './useReveal';

const APPROVAL_STEPS = [
  { n: '01', title: 'New review lands', sub: 'Google tells us within seconds', t: '0:00', final: false },
  { n: '02', title: 'AI drafts a reply in your voice', sub: 'Uses your Brand Voice settings, then your past edits (after five)', t: '+0:12', final: false },
  { n: '03', title: 'You get an email', sub: 'Review + draft + three buttons, in your inbox', t: '+0:15', final: false },
  { n: '04', title: 'You tap approve · we post it', sub: 'One tap on your phone · No login required', t: '+0:58', final: true },
];

/* ================== 04 THE GATE ================== */
export function FeatGate({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [tlRef, tlSeen] = useReveal<HTMLDivElement>();
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-gate"
      aria-label="The gate: Copilot approval"
      className="rw-dl-band is-paper"
    >
      <div className="rw-dl-col">
        <FeatIntro
          n="04"
          kicker="Copilot · your control"
          bar="var(--rw-sage-bar)"
          title="Every reply needs your sign-off."
          lede="On Copilot, every draft comes to you by email, with the review and the reply side-by-side. Tap approve, edit inline, or ask for a fresh draft. Nothing is posted without your go-ahead."
        />

        <div className="feat-split">
          <div ref={tlRef} className={cn('rw-dl-rv feat-steps-wrap', tlSeen && 'is-in')}>
            <ol className="feat-steps">
              {APPROVAL_STEPS.map((s) => (
                <li key={s.n} className="feat-step-row">
                  <span className={cn('feat-step-num', s.final && 'is-final')}>{s.n}</span>
                  <div className={cn('feat-step-card', s.final && 'is-final')}>
                    <p className="feat-step-t">{s.title}</p>
                    <p className="feat-step-s">{s.sub}</p>
                  </div>
                  <span className="feat-step-time">{s.t}</span>
                </li>
              ))}
            </ol>
          </div>

          <div ref={cardRef} className={cn('rw-dl-rv', cardSeen && 'is-in')}>
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot" />
                <span>Your approval page · no login</span>
                <span className="rw-dl-cap-tail">opens from the email</span>
              </div>
              <div className="rw-dl-quote">
                <div className="rw-dl-quote-meta">
                  New review ·{' '}
                  <span className="rw-dl-stars" aria-label="5 out of 5 stars">
                    <span aria-hidden="true">★★★★★</span>
                  </span>{' '}
                  · Sample reviewer
                </div>
                &ldquo;Al pastor tacos were incredible, the achiote marinade…&rdquo;
              </div>
              <div className="rw-dl-reply">
                <div className="rw-dl-reply-lbl">Draft reply · in your voice</div>
                <p>&ldquo;Thank you so much! We&apos;re thrilled the al pastor…&rdquo;</p>
              </div>
              <div className="rw-dl-acts">
                <span className="rw-dl-btn is-go">Approve &amp; post</span>
                <span className="rw-dl-btn">Edit</span>
                <span className="rw-dl-btn">Regenerate</span>
              </div>
              <p className="rw-dl-fine">One tap on your phone. Nothing posts until you say so.</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
