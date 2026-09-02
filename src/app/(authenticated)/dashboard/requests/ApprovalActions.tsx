'use client';

import './requests.css';

/**
 * The owner's verbs in the approval lane (#629).
 *
 * There are exactly two BATCH verbs — approve, or stop — and this file owns
 * both. Per-ask controls (exclude, regenerate) are row controls in
 * `SelectableAskList` and deliberately not verbs here: a third entry in
 * `ApprovalVerb` would mean a third batch-wide button, which no decision asks
 * for. What D22 still forbids is an EDIT affordance, and none exists. What
 * makes that checkable rather than aspirational is that adding a third verb
 * means widening `ApprovalVerb` and touching `actionVerb` in `ApprovalPanel` —
 * which is the point of naming them — not a claim that no other file renders
 * anything.
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
  /** True while THIS verb's own write is in flight — the button says so and
   *  refuses clicks. */
  busy: boolean;
  /**
   * True when the verb must refuse clicks for a reason that is NOT its own
   * write: at #860, a per-ask regeneration is in flight for this batch and
   * approving would silently throw away the copy the owner just asked for.
   *
   * Separate from `busy` because the two differ in what the button may SAY.
   * `busy` licenses "Approving…"; this does not — nothing is being approved,
   * and a button that claims otherwise while the owner waits on a regeneration
   * is the lane's copy lying about which act is in progress.
   */
  unavailable: boolean;
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
  unavailable,
  sendPhrase,
  onApprove,
  onHalt,
}: ApprovalActionsProps) {
  if (verb === null) return null;

  // The one-line reason a disabled verb owes the owner (UX audit D7). `busy`
  // needs none — the label itself says "Approving…" — so the reason renders
  // only for the block the button cannot explain by relabelling.
  const reason = !busy && unavailable ? UNAVAILABLE_REASON[verb] : null;

  return (
    <div className="rq-approval-actions">
      <button
        type="button"
        className={`btn ${VERB_BUTTON_CLASS[verb]} rq-action`}
        onClick={verb === 'approve' ? onApprove : onHalt}
        disabled={busy || unavailable}
        aria-describedby={reason !== null ? REASON_ID : undefined}
      >
        {approvalButtonLabel({ verb, busy, sendPhrase })}
      </button>
      {reason !== null && (
        <p className="rq-action-reason" id={REASON_ID}>
          {reason}
        </p>
      )}
    </div>
  );
}

/**
 * What the verb's button says. `busy` licenses the in-progress form ("Approving…",
 * "Stopping…"); the idle approve label carries the live count so deselecting an
 * ask moves the text. Total over the verbs, like `UNAVAILABLE_REASON`.
 */
export function approvalButtonLabel(input: {
  verb: ApprovalVerb;
  busy: boolean;
  sendPhrase: string;
}): string {
  if (input.verb === 'approve') {
    return input.busy ? 'Approving…' : `Approve and send ${input.sendPhrase}`;
  }
  return input.busy ? 'Stopping…' : 'Stop this batch';
}

const REASON_ID = 'rq-approval-action-reason';

/** Approve is the primary act; stop is the secondary one. */
const VERB_BUTTON_CLASS: Readonly<Record<ApprovalVerb, string>> = {
  approve: 'btn-primary',
  halt: 'btn-secondary',
};

/** Why the verb refuses clicks for a reason that is not its own write. Total
 *  over the verbs so a third verb has to say what its block means. */
const UNAVAILABLE_REASON: Readonly<Record<ApprovalVerb, string>> = {
  approve: 'You can approve once the new version of that message is ready.',
  halt: 'You can stop this batch once the new version of that message is ready.',
};
