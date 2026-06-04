'use client';

import { useEffect, useState } from 'react';

const REVIEW = {
  name: 'Rachel K.',
  initial: 'R',
  stars: 5,
  text: 'Came in for a last-minute birthday cake and they completely pulled through. The cake was beautiful, tasted amazing, and my 7-year-old still talks about it. Thank you!',
};
const REPLY = "Rachel, you made our week! We are so glad the cake landed and that your 7 year old loved it. Tell her happy belated birthday from the team, and come by anytime.\n\n— Claire, owner";

function useTyped(text: string, speed = 16, startDelay = 600): [string, boolean] {
  // State is tagged with the text it belongs to. When `text` changes we don't
  // reset state in the effect; instead the output reads as empty/not-done until
  // the typing run for the new text starts producing values.
  const [typed, setTyped] = useState<{ forText: string; out: string; done: boolean }>(
    { forText: text, out: '', done: false },
  );
  useEffect(() => {
    if (!text) return;
    let i = 0;
    let waited = 0;
    const iv = setInterval(() => {
      // Honor the start delay by skipping the leading ticks, so the whole
      // animation runs off a single timer.
      if (waited < startDelay) {
        waited += speed;
        return;
      }
      i++;
      setTyped({ forText: text, out: text.slice(0, i), done: i >= text.length });
      if (i >= text.length) clearInterval(iv);
    }, speed);
    return () => clearInterval(iv);
  }, [text, speed, startDelay]);
  const out = typed.forText === text ? typed.out : '';
  const done = typed.forText === text ? typed.done : false;
  return [out, done];
}

interface HeroProps {
  onBook: () => void;
  onTry: () => void;
  primaryCtaLabel: string;
  primaryCtaDisabled?: boolean;
}

export function Hero({ onBook, onTry, primaryCtaLabel, primaryCtaDisabled }: HeroProps) {
  const [reviewText, reviewDone] = useTyped(REVIEW.text, 16, 700);
  const [replyText, replyDone] = useTyped(reviewDone ? REPLY : '', 14, 500);
  const [approved, setApproved] = useState(false);

  return (
    <section className="rw-hero" id="rw-hero">
      <div className="rw-hero-split">
        <div>
          <div className="rw-eyebrow">Review response, on autopilot</div>
          <h1>
            Every review gets the reply it <em>deserves</em>.
          </h1>
          <p className="rw-lead">
            RepWorth drafts a reply to every Google review in your voice, notifies you, and posts it the moment you tap approve. You save about fifteen
            hours a week. Your customers feel heard within minutes.
          </p>
          <div className="rw-hero-ctas">
            <button
              type="button"
              className="rw-btn-pill"
              onClick={onBook}
              disabled={primaryCtaDisabled}
            >
              {primaryCtaLabel}
            </button>
            {/* <button type="button" className="rw-btn-ghost" onClick={onTry}>
              Or see how it works →
            </button> */}
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <div className="rw-float-stat a">
            Response rate
            <b>96%</b>
          </div>
          <div className="rw-hero-demo">
            <div className="rw-demo-chip">
              <span className="rw-demo-chip-dot" />
              Live, right now
            </div>
            <div className="rw-demo-review">
              <div className="rw-demo-avatar">{REVIEW.initial}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="rw-demo-name">{REVIEW.name}</div>
                <div className="rw-demo-stars" aria-label={`${REVIEW.stars} out of 5 stars`}>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <span key={i}>{i < REVIEW.stars ? '★' : '☆'}</span>
                  ))}
                </div>
                <div className="rw-demo-text">
                  {reviewText}
                  {!reviewDone && <span className="rw-caret" />}
                </div>
              </div>
            </div>
            <div className="rw-demo-arrow">
              <span className="rw-line" />
              RepWorth drafts
              <span className="rw-line" />
            </div>
            <div className="rw-demo-reply">
              <div className="rw-demo-reply-label">
                <span className="rw-demo-chip-dot" />
                Draft ready in 8 seconds
              </div>
              <div className="rw-demo-reply-text">
                {replyText}
                {reviewDone && !replyDone && <span className="rw-caret" />}
              </div>
              <div className="rw-demo-actions">
                <button
                  type="button"
                  className={`rw-demo-act approve ${approved ? 'approved' : ''}`}
                  onClick={() => setApproved(true)}
                  disabled={!replyDone}
                >
                  {approved ? '✓ Posted to Google' : 'Approve'}
                </button>
                <button type="button" className="rw-demo-act" disabled={!replyDone}>Edit</button>
                <button type="button" className="rw-demo-act" disabled={!replyDone}>Regenerate</button>
              </div>
            </div>
          </div>
          <div className="rw-float-stat b">
            This week
            <b>+127 replies</b>
          </div>
        </div>
      </div>
    </section>
  );
}
