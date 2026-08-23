'use client';

import { type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { FeatSteps, ReviewStars, type FeatStep } from './FeatPrimitives';
import { useReveal } from './useReveal';

const APPROVAL_STEPS: readonly FeatStep[] = [
  { n: '01', title: 'New review lands', sub: 'Google tells us within seconds', t: '0:00', final: false },
  { n: '02', title: 'AI drafts a reply in your voice', sub: 'Uses your Brand Voice settings, then your past edits (after five)', t: '+0:12', final: false },
  { n: '03', title: 'You get an email', sub: 'Review + draft + three buttons, in your inbox', t: '+0:15', final: false },
  { n: '04', title: 'You tap approve · we post it', sub: 'One tap on your phone · No login required', t: '+0:58', final: true },
];

/* ================== 04 THE GATE (wide chapter: timeline and approval page side by side) ================== */
export function FeatGate({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [arRef, arSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-gate"
      aria-label="The gate: Copilot approval"
      className="rw-dl-band is-paper"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-wide">
          <FeatIntro
            n="04"
            kicker="Copilot · your control"
            bar="var(--rw-sage-bar)"
            group="Care and control"
            title="Every reply needs your sign-off."
            lede="On Copilot, every draft comes to you by email, with the review and the reply side-by-side. Tap approve, edit inline, or ask for a fresh draft. Nothing is posted without your go-ahead."
          />

          <div ref={arRef} className={cn('feat-ch-ar feat-two rw-dl-rv', arSeen && 'is-in')}>
            <FeatSteps steps={APPROVAL_STEPS} />

            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot" />
                <span>Your approval page · no login</span>
                <span className="rw-dl-cap-tail">opens from the email</span>
              </div>
              <div className="rw-dl-quote">
                <div className="rw-dl-quote-meta">
                  New review · <ReviewStars rating={5} /> · Sample reviewer
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
