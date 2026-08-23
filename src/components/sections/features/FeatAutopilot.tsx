'use client';

import type { RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from './useReveal';

/* ================== 05 AUTOPILOT (split chapter: text left, queued post right) ================== */
export function FeatAutopilot({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();

  return (
    <section
      ref={innerRef}
      id="f-autopilot"
      aria-label="Autopilot: within your rules"
      className="rw-dl-band"
    >
      <div className="rw-dl-col">
        <div className="feat-ch is-split">
          <FeatIntro
            n="05"
            kicker="Autopilot · within your rules"
            bar="var(--rw-gold-bar)"
            group="Care and control"
            title="Hands-off, inside your rules."
            lede="On Autopilot, replies to 4–5★ reviews that pass our safety checks can post themselves, but only inside rules you set. You choose 5★ only or 4–5★, a daily limit (1–50, default 10), and a 15- or 30-minute veto window, for your account or per location. Until the window closes, the reply is yours to stop with one tap. Negative reviews are never auto-posted."
          />

          <div ref={cardRef} className={cn('feat-ch-ar rw-dl-rv', cardSeen && 'is-in')}>
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span className="rw-dl-cap-dot" />
                <span>Queued auto-post · sample · settings matched</span>
                <span className="rw-dl-cap-tail">posting in 14:32</span>
              </div>
              <div className="rw-dl-rec feat-rec-flush">
                <div>
                  <div className="rw-dl-rec-k">Ratings allowed</div>
                  <div className="rw-dl-rec-v">4–5★ only</div>
                </div>
                <div>
                  <div className="rw-dl-rec-k">Daily limit</div>
                  <div className="rw-dl-rec-v">10 / day</div>
                </div>
                <div>
                  <div className="rw-dl-rec-k">Veto window</div>
                  <div className="rw-dl-rec-v">15 min</div>
                </div>
              </div>
              <div className="rw-dl-reply feat-reply-gap">
                <div className="rw-dl-reply-lbl">Reply · cleared to post · one tap stops it</div>
                <p>
                  &ldquo;Thank you so much! We&apos;re thrilled the al pastor tacos hit the spot.
                  Looking forward to your next visit!&rdquo;
                </p>
              </div>
              <div className="rw-dl-acts">
                <span className="rw-dl-btn">Veto this reply</span>
              </div>
              <p className="rw-dl-fine">
                Posting when the window closes. One tap stops it; nothing is final until then.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
