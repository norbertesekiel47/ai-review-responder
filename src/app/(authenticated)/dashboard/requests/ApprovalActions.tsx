'use client';

import './requests.css';

/**
 * The owner's verbs in the approval lane (#629).
 *
 * There are exactly two — approve, or stop — and this is the only file in the
 * lane that renders a control at all. That is what makes D22 checkable rather
 * than aspirational: there is no edit affordance and no regenerate affordance
 * anywhere here, and adding one would mean widening `ApprovalVerb` and touching
 * `actionVerb` in `ApprovalPanel`, which is the point of naming them.
 *
 * Which verb a Batch state offers is a lifecycle question and stays upstream
 * with the other exhaustive switches; this file only knows how a verb looks.
 */

export type ApprovalVerb = 'approve' | 'halt';

export interface ApprovalActionsProps {
  /** The verb this Batch state offers, or null when it offers none. */
  verb: ApprovalVerb | null;
  /** True while a write is in flight — the button says so and refuses clicks. */
  busy: boolean;
  /** The live count as prose ("3 messages"). The approve label carries it, so
   *  deselecting an ask moves the button's text. Formatted upstream, which owns
   *  the count vocabulary the rest of the panel copy shares. */
  sendPhrase: string;
  onApprove: () => void;
  onHalt: () => void;
}

export function ApprovalActions({
  verb,
  busy,
  sendPhrase,
  onApprove,
  onHalt,
}: ApprovalActionsProps) {
  if (verb === null) return null;

  return (
    <div className="rq-approval-actions">
      {verb === 'approve' ? (
        <button
          type="button"
          className="btn btn-primary rq-action"
          onClick={onApprove}
          disabled={busy}
        >
          {busy ? 'Approving…' : `Approve and send ${sendPhrase}`}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-secondary rq-action"
          onClick={onHalt}
          disabled={busy}
        >
          {busy ? 'Stopping…' : 'Stop this batch'}
        </button>
      )}
    </div>
  );
}
