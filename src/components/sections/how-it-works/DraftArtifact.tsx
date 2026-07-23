'use client';

import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export function DraftArtifact() {
  const full =
    "Sarah, thank you — that's genuinely wonderful to hear. We take punctuality seriously because we know your schedule doesn't wait for ours. See you again soon.";
  const reducedMotion = usePrefersReducedMotion();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    // Reduced motion: skip the looping typewriter. The completed draft is
    // rendered statically at render time (`displayedDraft`), so no in-effect
    // setState is needed here.
    if (reducedMotion) return;
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
      if (i <= full.length) {
        setTyped(full.slice(0, i));
        i += 2;
      } else if (hold < 2400) {
        hold += 22;
      } else {
        i = 0;
        hold = 0;
      }
    }, 22);
    return () => clearInterval(iv);
  }, [full, reducedMotion]);
  const displayedDraft = reducedMotion ? full : typed;
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <span
          className="hiw-artifact-cap-dot"
          style={{ background: '#F2C3B9', boxShadow: '0 0 0 4px rgba(242,195,185,0.2)' }}
        />
        <span>Draft generation · voice model</span>
        <span className="hiw-artifact-cap-tail">~4 sec</span>
      </div>
      <div className="hiw-draft">
        <div className="hiw-draft-src">
          <div className="hiw-draft-src-meta">Input · Review from Sarah L.</div>
          Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
          I&apos;ll be back!
        </div>
        <div className="hiw-draft-arrow">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
        </div>
        <div className="hiw-draft-out">
          <span className="hiw-draft-badge">Draft · in your voice</span>
          <p>
            {displayedDraft}
            <span className="hiw-draft-typing" />
          </p>
        </div>
        <div className="hiw-draft-voice">
          <div className="hiw-voice-chip">
            <span className="hiw-voice-chip-lbl">Tone</span>
            <span className="hiw-voice-chip-val">Warm · direct</span>
          </div>
          <div className="hiw-voice-chip">
            <span className="hiw-voice-chip-lbl">Length</span>
            <span className="hiw-voice-chip-val">28 words</span>
          </div>
        </div>
      </div>
    </div>
  );
}
