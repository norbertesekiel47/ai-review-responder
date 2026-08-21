'use client';

import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

const VETO_START_S = 872; // 14:32, mid-window — the demo's illustrative state

function CopilotPanel() {
  const [approved, setApproved] = useState(false);
  return (
    <div className="rw-dl-card">
      <div className="rw-dl-cap">
        <span className="rw-dl-cap-dot" />
        <span>Your approval page · no login</span>
        <span className="rw-dl-cap-tail">opens from the email</span>
      </div>
      <div className="rw-dl-reply">
        <div className="rw-dl-reply-lbl">Suggested reply</div>
        <p>
          Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
          because we know your schedule doesn&apos;t wait for ours. See you again soon.
        </p>
      </div>
      <div className="rw-dl-acts">
        <button
          type="button"
          className="rw-dl-btn is-go"
          onClick={() => setApproved(true)}
          disabled={approved}
        >
          {approved ? 'Posted to Google' : 'Approve and post'}
        </button>
        <span className="rw-dl-btn">Edit</span>
        <span className="rw-dl-btn">Regenerate</span>
      </div>
      <p className="rw-dl-fine">
        {approved
          ? 'Posted as “Response from the owner”. Receipt logged in your dashboard.'
          : 'One tap. The reply posts to Google as “Response from the owner”.'}
      </p>
      <div aria-live="polite" className="sr-only">
        {approved ? 'Approved. The reply posted to Google.' : ''}
      </div>
    </div>
  );
}

function AutopilotPanel() {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [vetoed, setVetoed] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(VETO_START_S);
  useEffect(() => {
    if (prefersReducedMotion || vetoed) return;
    const id = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : VETO_START_S));
    }, 1000);
    return () => clearInterval(id);
  }, [prefersReducedMotion, vetoed]);
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');
  return (
    <div className="rw-dl-card">
      <div className="rw-dl-cap">
        <span className="rw-dl-cap-dot" />
        <span>Autopilot · settings check + veto window</span>
        <span className="rw-dl-cap-tail">{vetoed ? 'held' : `posting in ${mm}:${ss}`}</span>
      </div>
      <div className="rw-dl-rec hiw-rec-flush">
        <div>
          <div className="rw-dl-rec-k">Ratings allowed</div>
          <div className="rw-dl-rec-v">4–5★ · safety-checked</div>
        </div>
        <div>
          <div className="rw-dl-rec-k">Daily limit</div>
          <div className="rw-dl-rec-v">3 of 10 used</div>
        </div>
        <div>
          <div className="rw-dl-rec-k">Veto window</div>
          <div className="rw-dl-rec-v">15 min</div>
        </div>
      </div>
      <div className="rw-dl-reply hiw-reply-gap">
        <div className="rw-dl-reply-lbl">
          {vetoed ? 'Vetoed: draft held for your review' : 'Cleared to post · one tap stops it'}
        </div>
        <p>
          Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
          because we know your schedule doesn&apos;t wait for ours. See you again soon.
        </p>
      </div>
      <div className="rw-dl-acts">
        <button
          type="button"
          className="rw-dl-btn"
          onClick={() => setVetoed(true)}
          disabled={vetoed}
        >
          {vetoed ? 'Vetoed' : 'Veto this reply'}
        </button>
      </div>
      <div aria-live="polite" className="sr-only">
        {vetoed ? 'Reply vetoed. The draft is held for your review.' : ''}
      </div>
    </div>
  );
}

/**
 * The gate fork — a working Copilot / Autopilot switch (Daylight Gallery II):
 * a segmented control swaps between the approval-page mock and the
 * veto-window mock.
 */
export function GateArtifact() {
  const [mode, setMode] = useState<'copilot' | 'autopilot'>('copilot');
  return (
    <div>
      <div className="rw-dl-tabs hiw-gate-tabs" role="tablist" aria-label="Gate mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'copilot'}
          aria-controls="hiw-gate-copilot"
          id="hiw-gate-tab-copilot"
          onClick={() => setMode('copilot')}
        >
          Copilot · you approve
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'autopilot'}
          aria-controls="hiw-gate-autopilot"
          id="hiw-gate-tab-autopilot"
          onClick={() => setMode('autopilot')}
        >
          Autopilot · your policy approves
        </button>
      </div>
      <div
        id="hiw-gate-copilot"
        role="tabpanel"
        aria-labelledby="hiw-gate-tab-copilot"
        hidden={mode !== 'copilot'}
      >
        <CopilotPanel />
      </div>
      <div
        id="hiw-gate-autopilot"
        role="tabpanel"
        aria-labelledby="hiw-gate-tab-autopilot"
        hidden={mode !== 'autopilot'}
      >
        <AutopilotPanel />
      </div>
    </div>
  );
}
