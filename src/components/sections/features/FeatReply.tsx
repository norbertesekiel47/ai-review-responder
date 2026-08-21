'use client';

import { useState, type RefObject } from 'react';
import { cn } from '@/lib/ui/cn';
import { FeatIntro } from './FeatIntro';
import { useReveal } from './useReveal';

const AI_REPLIES = {
  before: {
    label: 'Generic reply',
    meta: 'Template · no personalization',
    text: '"Thank you for your feedback! We appreciate your business and hope to see you again soon."',
    diag: [
      ['Written from scratch', 'No'],
      ['References detail', 'No'],
      ['Invites return', 'Generic'],
    ],
  },
  after: {
    label: 'Your response',
    meta: 'Personalized · in your voice',
    text: `"Thank you so much! We're thrilled the al pastor tacos hit the spot; that smoky-sweet balance is exactly what we go for. Looking forward to your next visit!"`,
    diag: [
      ['Written from scratch', 'Yes'],
      ['References detail', 'Al pastor · achiote'],
      ['Invites return', 'Next visit'],
    ],
  },
} as const;

/* ================== 01 REPLY ================== */
export function FeatReply({ innerRef }: { innerRef: RefObject<HTMLElement | null> }) {
  const [tab, setTab] = useState<'before' | 'after'>('after');
  const [cardRef, cardSeen] = useReveal<HTMLDivElement>();

  const r = AI_REPLIES[tab];

  return (
    <section ref={innerRef} id="f-reply" aria-label="Reply: the drafting agent" className="rw-dl-band">
      <div className="rw-dl-col">
        <FeatIntro
          n="01"
          kicker="Reply · your drafter"
          bar="var(--rw-mist-bar)"
          title="Every reply written from scratch, never from a template."
          lede="Reply is the drafting agent. It reads the actual review, references what the customer mentioned, and writes in a voice that sounds like you. No “thanks for your feedback” filler."
        />

        <div ref={cardRef} className={cn('rw-dl-rv feat-cmp-wrap', cardSeen && 'is-in')}>
          <div className="rw-dl-tabs feat-cmp-tabs">
            <button
              type="button"
              onClick={() => setTab('before')}
              aria-pressed={tab === 'before'}
            >
              Generic reply
            </button>
            <button
              type="button"
              onClick={() => setTab('after')}
              aria-pressed={tab === 'after'}
            >
              Your response
            </button>
          </div>

          <div className="feat-cmp">
            {/* Review card */}
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span>Sample reviewer</span>
                <span
                  className="rw-dl-stars"
                  aria-label="5 out of 5 stars"
                >
                  <span aria-hidden="true">★★★★★</span>
                </span>
                <span className="rw-dl-cap-tail">2h ago · Google</span>
              </div>
              <p className="feat-cmp-text">
                &ldquo;The al pastor tacos were incredible, that smoky-sweet achiote marinade is
                unreal. Will be back with friends.&rdquo;
              </p>
            </div>

            {/* Response card */}
            <div className="rw-dl-card">
              <div className="rw-dl-cap">
                <span>{r.label}</span>
                <span className="rw-dl-cap-tail">{r.meta}</span>
              </div>
              <p className="feat-cmp-text">{r.text}</p>
              <div className="feat-diag">
                {r.diag.map(([k, v]) => (
                  <div key={k}>
                    <div className="feat-diag-k">{k}</div>
                    <div className="feat-diag-v">{v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
