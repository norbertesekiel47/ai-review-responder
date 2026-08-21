'use client';

import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

const FULL_DRAFT =
  "Sarah, thank you. That's genuinely wonderful to hear. We take punctuality seriously because we know your schedule doesn't wait for ours. See you again soon.";

export function DraftArtifact() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    // Reduced motion: the completed draft renders statically (displayedDraft).
    if (prefersReducedMotion) return;
    // Single timer drives lead-in → type → hold → loop, so the effect has one
    // state setter (avoids a chain of setState calls across nested timers).
    let i = 0;
    let lead = 0;
    let hold = 0;
    const iv = setInterval(() => {
      if (lead < 400) {
        lead += 22;
        return;
      }
      if (i <= FULL_DRAFT.length) {
        setTyped(FULL_DRAFT.slice(0, i));
        i += 2;
      } else if (hold < 2600) {
        hold += 22;
      } else {
        i = 0;
        hold = 0;
      }
    }, 22);
    return () => clearInterval(iv);
  }, [prefersReducedMotion]);
  const displayedDraft = prefersReducedMotion ? FULL_DRAFT : typed;
  return (
    <div className="rw-dl-card">
      <div className="rw-dl-cap">
        <span className="rw-dl-cap-dot is-bar" style={{ ['--bar' as string]: 'var(--rw-mist-bar)' }} />
        <span>Draft generation · AI writer</span>
      </div>
      <div className="rw-dl-quote">
        <div className="rw-dl-quote-meta">Input · Review from Sarah L.</div>
        Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
        I&apos;ll be back!
      </div>
      <div className="rw-dl-arrow" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M19 12l-7 7-7-7" />
        </svg>
      </div>
      <div className="rw-dl-reply">
        <div className="rw-dl-reply-lbl">Draft · in your voice</div>
        <p className="hiw-drafttype">
          {displayedDraft}
          {!prefersReducedMotion && <span className="rw-dl-caret" aria-hidden="true" />}
        </p>
      </div>
      <div className="rw-dl-chips">
        <span className="rw-dl-chip"><span>Tone</span>Warm · direct</span>
        <span className="rw-dl-chip"><span>Length</span>25 words</span>
        <span className="rw-dl-chip"><span>Safety check</span>Passed</span>
      </div>
    </div>
  );
}
