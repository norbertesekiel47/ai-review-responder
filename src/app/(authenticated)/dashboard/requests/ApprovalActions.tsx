'use client';

import './requests.css';

/**
 * The owner's verbs in the approval lane (#629).
 *
 * There are exactly two — approve, or stop — and this file owns both. The lane
 * has exactly one other control anywhere, the per-ask exclude checkbox in
 * `SelectableAskList`, and that pair is the whole surface: no edit affordance
 * and no regenerate affordance exists (D22). What makes D22 checkable rather
 * than aspirational is that adding a third verb means widening `ApprovalVerb`
 * and touching `actionVerb` in `ApprovalPanel` — which is the point of naming
 * them — not a claim that no other file renders anything.
 *
 * Which verb a Batch state offers is a lifecycle question and stays upstream
 * with the other exhaustive switches; this file only knows how a verb looks.
 * `halt` is the verb's name everywhere in code (CONTEXT.md "Halt latch"); the
 * owner-facing word is "stop", the one carve-out that term allows.
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
