'use client';

import { useState } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

export function CopilotGateCard() {
  const reducedMotion = usePrefersReducedMotion();
  const [state, setState] = useState<'pending' | 'approving' | 'approved' | 'regenerating'>('pending');
  const onApprove = () => {
    if (reducedMotion) {
      setState('approved');
      return;
    }
    setState('approving');
    setTimeout(() => setState('approved'), 700);
  };
  const onRegen = () => {
    if (reducedMotion) {
      setState('pending');
      return;
    }
    setState('regenerating');
    setTimeout(() => setState('pending'), 1100);
  };
  const statusMessage =
    state === 'approving'
      ? 'Approving the reply.'
      : state === 'approved'
        ? 'Approved. Posting the reply to Google.'
        : state === 'regenerating'
          ? 'Regenerating the draft reply.'
          : '';
  return (
    <div className="hiw-artifact">
      <div className="hiw-artifact-cap">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#97B3AE' }} aria-hidden>
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
        <span>owner@brightlinen.com · Inbox</span>
        <span className="hiw-artifact-cap-tail">10:42 AM</span>
      </div>
      <div className="hiw-email">
        <div className="hiw-email-head">
          <div className="hiw-email-head-l">
            <span className="hiw-brand-mini" aria-hidden />
            <strong style={{ color: 'var(--rw-ink)' }}>RepWorth</strong>
            <span>&lt;drafts@repworth.net&gt;</span>
          </div>
          <div>to you</div>
        </div>
        <h4 className="hiw-email-subj">New 5★ review from Sarah L., ready to approve</h4>
        <p className="hiw-email-meta">
          We drafted a reply in your voice. Tap to approve, edit, or regenerate.
        </p>

        <div className="hiw-email-quote">
          <div className="hiw-email-quote-meta">
            SARAH L. ·{' '}
            <span aria-label="5 out of 5 stars">
              <span aria-hidden="true">★★★★★</span>
            </span>
          </div>
          Best dry cleaners in town. Picked up my suits on time and they came back looking sharp.
          I&apos;ll be back!
        </div>
        <div className="hiw-email-reply">
          <div className="hiw-email-reply-meta">Suggested reply</div>
          Sarah, thank you. That&apos;s genuinely wonderful to hear. We take punctuality seriously
          because we know your schedule doesn&apos;t wait for ours. See you again soon.
        </div>

        <div className="hiw-email-actions">
          {state === 'approved' ? (
            <button
              type="button"
              className="hiw-btn hiw-btn-approve"
              disabled
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Approved, posting to Google
            </button>
          ) : (
            <>
              <button
                type="button"
                className="hiw-btn hiw-btn-approve"
                onClick={onApprove}
                disabled={state === 'approving'}
              >
                {state === 'approving' ? 'Sending…' : 'Approve & post'}
              </button>
              <button type="button" className="hiw-btn hiw-btn-ghost" disabled={state === 'regenerating'}>
                Edit first
              </button>
              <button
                type="button"
                className="hiw-btn hiw-btn-ghost"
                onClick={onRegen}
                disabled={state === 'regenerating'}
              >
                {state === 'regenerating' ? 'Regenerating…' : 'Regenerate'}
              </button>
            </>
          )}
        </div>
        <div aria-live="polite" className="sr-only">
          {statusMessage}
        </div>
        <div className="hiw-email-foot">
          <span>Responds from owner@brightlinen.com</span>
          <span>One tap · email, Telegram, or WhatsApp</span>
        </div>
      </div>
    </div>
  );
}
