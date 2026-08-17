'use client';

import type { RegenBudgetStatus } from '@/lib/costs/tracker';
import type { AskAttemptView } from '@/lib/solicitation/batch-view';
import './requests.css';

/**
 * The owner approval lane's ask list (#629), in its two forms.
 *
 * Each row shows the message itself — subject and body — because approving is
 * an act of reading (intake `user_visible_behavior[0]`), and the 15-minute veto
 * window is an undo rather than a review window only if the owner has already
 * read what they approved.
 *
 * REDACTION (invariant #4 ported to the send lane; design D6a). Nothing here
 * ever holds an `AskAttemptView`: both components take `AskRowView`, the
 * projection `ApprovalPanel`'s `toRows` produces, and that projection describes
 * an owner-READABLE attempt only — a `moderation_high` row never becomes one,
 * so no held message is reachable from here even by accident. The type-only
 * import below exists solely to pin `DeliveryStatus` and the content columns to
 * the read model's vocabulary; no attempt value crosses this boundary. Widening
 * these props to take the attempt would be the way the guarantee gets lost — the
 * projection is the choke point, so it stays upstream of this file.
 *
 * TWO components rather than one with a `selectable` flag: an approved batch is
 * settled, and `AskList` is structurally unable to offer a control because it
 * has no toggle to call and no exclusion set to read. Same reasoning style as
 * `toRows` — make the guarantee shape rather than discipline. Neither form
 * renders an EDIT affordance (D22). `SelectableAskList` renders two per-ask
 * controls — the exclude checkbox and the regenerate button (#860); `AskList`
 * renders none and is structurally unable to, which is the whole reason the two
 * components are separate.
 */

type DeliveryStatus = AskAttemptView['deliveryStatus'];

/** Keyed on the union so a widened `delivery_status` vocabulary is a compile
 *  error here rather than a blank cell in the list. */
const STATUS_LABEL: Record<DeliveryStatus, string> = {
  rendered: 'Ready to send',
  queued: 'Queued',
  sending: 'Sending',
  sent: 'Sent',
  withheld: 'Held back',
  failed: 'Could not send',
  unknown: 'Unknown',
};

/** The resting label of the per-ask regenerate control. "Regenerate" is the
 *  domain's own name for the act (**Ask regeneration**) and the word the
 *  Reviews lane's `PastReplyCard` already puts on the same affordance. */
const REGENERATE_LABEL = 'Regenerate';

/** The in-flight label. Deliberately NOT "Rewriting…": **Ask regeneration**'s
 *  `_Avoid_` list bans `rewrite` (with edit, redraft, retry and re-roll), and
 *  unlike the **Halt latch**'s single "stop" carve-out that list has no
 *  owner-facing exception. "A new version" is the phrase the approvable-mode
 *  copy uses, so the button and the paragraph above it say the same thing. */
const REGENERATING_LABEL = 'Writing a new version…';

/**
 * One list row: an owner-readable attempt, projected. Deliberately NOT the
 * attempt itself — projecting first is what makes the redacted half of the D6a
 * rule structural instead of a habit. There is no `redacted` arm on purpose:
 * a held attempt never becomes a row at all.
 *
 * `subject` and `body` are nullable for the same reason they are nullable
 * upstream — a `render_failed` attempt was never written, and a retention-
 * emptied one no longer holds its bytes (migration 092).
 */
export interface AskRowView {
  outreachId: string;
  /** The ask this attempt belongs to — the key for its regenerate budget and
   *  the id the regenerate route takes. `outreachId` cannot serve: a
   *  regeneration mints a new one. */
  askId: string;
  /** 1-based. The panel compares it across a refetch to tell a landed
   *  regeneration from one that settled without changing anything. */
  attemptNo: number;
  contactName: string;
  deliveryStatus: DeliveryStatus;
  subject: string | null;
  body: string | null;
}

export interface SelectableAskListProps {
  /** The rows the owner may still deselect — `rendered` asks only, because
   *  `rendered` is the one status the approve route accepts an exclusion for. */
  rows: readonly AskRowView[];
  /** ASK ids the owner has deselected, not outreach ids: an ask's identity
   *  survives a regeneration and its outreach row's does not. Exclusion is an
   *  act, not a default, so an empty set means "send to everyone in the list". */
  excluded: ReadonlySet<string>;
  onToggle: (askId: string) => void;
  /** True while a write is in flight. */
  disabled: boolean;
  /** Per-ask budget, keyed by askId. An ABSENT entry means UNKNOWN: no counter
   *  renders and the control stays enabled (F6, the `PastReplyCard`
   *  precedent) — inverting that would disable every control during an
   *  Upstash outage. */
  regenBudgets: Record<string, RegenBudgetStatus>;
  /** The ask being regenerated right now, or null. Server-authoritative: it is
   *  read from the in-flight `job_outbox` row, so a second tab sees it too. */
  regeneratingAskId: string | null;
  onRegenerate: (askId: string) => void;
}

/** The list while the owner is still choosing: one checkbox and one regenerate
 *  control per sendable ask, above the message that ask will send. */
export function SelectableAskList({
  rows,
  excluded,
  onToggle,
  disabled,
  regenBudgets,
  regeneratingAskId,
  onRegenerate,
}: SelectableAskListProps) {
  if (rows.length === 0) return null;

  return (
    <ul className="rq-asks">
      {rows.map((row) => (
        <li key={row.outreachId} className="rq-ask">
          <label className="rq-ask-label">
            <input
              type="checkbox"
              className="rq-ask-check"
              checked={!excluded.has(row.askId)}
              onChange={() => onToggle(row.askId)}
              disabled={disabled}
            />
            <span className="rq-ask-name">Send to {displayName(row)}</span>
          </label>
          <span className="rq-ask-status">{STATUS_LABEL[row.deliveryStatus]}</span>
          <RegenerateControl
            row={row}
            budget={regenBudgets[row.askId]}
            regenerating={regeneratingAskId === row.askId}
            /* Disabled while ANY regeneration is in flight (one per batch), and
               on a deselected row: regenerating it would mint a new outreachId,
               and offering the owner a control that quietly reshuffles which
               row their deselection is about is worse than not offering it. */
            disabled={disabled || regeneratingAskId !== null || excluded.has(row.askId)}
            onRegenerate={onRegenerate}
          />
          <AskMessage row={row} />
        </li>
      ))}
    </ul>
  );
}

/** The per-ask regenerate control and its budget counter. Split out so the
 *  three reasons it can be unavailable read as three conditions rather than one
 *  boolean expression buried in the list. */
function RegenerateControl({
  row,
  budget,
  regenerating,
  disabled,
  onRegenerate,
}: {
  row: AskRowView;
  budget?: RegenBudgetStatus;
  regenerating: boolean;
  disabled: boolean;
  onRegenerate: (askId: string) => void;
}) {
  const exhausted = budget !== undefined && budget.remaining === 0;

  return (
    <span className="rq-ask-regen">
      <button
        type="button"
        className="btn btn-secondary rq-ask-regen-btn"
        onClick={() => onRegenerate(row.askId)}
        disabled={disabled || exhausted || regenerating}
        aria-label={`Ask for a new version of the message to ${displayName(row)}`}
      >
        {regenerating ? REGENERATING_LABEL : REGENERATE_LABEL}
      </button>
      {/* No counter at all when the budget is UNKNOWN (F6). An entry that IS
          present with `used: 0` is a known zero and does render. */}
      {budget !== undefined && (
        <span className="rq-ask-regen-count">
          {budget.used} of {budget.limit} today
        </span>
      )}
    </span>
  );
}

/** The same list once the batch is settled: names, statuses and the copy that
 *  was approved — read-only, no controls. */
export function AskList({ rows }: { rows: readonly AskRowView[] }) {
  if (rows.length === 0) return null;

  return (
    <ul className="rq-asks">
      {rows.map((row) => (
        <li key={row.outreachId} className="rq-ask">
          <span className="rq-ask-name">{displayName(row)}</span>
          <span className="rq-ask-status">{STATUS_LABEL[row.deliveryStatus]}</span>
          <AskMessage row={row} />
        </li>
      ))}
    </ul>
  );
}

/** What the owner is approving, verbatim. A row with neither half says so
 *  plainly rather than rendering an empty block: "nothing was written" and "we
 *  hid it from you" must not look the same. */
function AskMessage({ row }: { row: AskRowView }) {
  if (row.subject === null && row.body === null) {
    return <p className="rq-ask-empty">No message was written for this contact.</p>;
  }

  return (
    <div className="rq-ask-message">
      {row.subject !== null && <p className="rq-ask-subject">{row.subject}</p>}
      {row.body !== null && <p className="rq-ask-body">{row.body}</p>}
    </div>
  );
}

/** `solicitation_contacts.name` is nullable-ish TEXT upstream; an empty string
 *  must still produce a usable checkbox label. */
function displayName(row: AskRowView): string {
  return row.contactName || 'Unnamed contact';
}
