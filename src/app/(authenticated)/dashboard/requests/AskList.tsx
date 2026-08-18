'use client';

import type { RegenBudgetStatus } from '@/lib/costs/tracker';
import type { AskAttemptView } from '@/lib/solicitation/batch-view';
import './requests.css';

/**
 * The owner approval lane's ask list (#629), in its THREE forms.
 *
 * Each row shows the message itself — subject and body — because approving is
 * an act of reading (intake `user_visible_behavior[0]`), and the 15-minute veto
 * window is an undo rather than a review window only if the owner has already
 * read what they approved.
 *
 * REDACTION (invariant #4 ported to the send lane; design D6a). Nothing here
 * ever holds an `AskAttemptView`: all three components take `AskRowView`, the
 * projection `ApprovalPanel`'s `toRows` produces, and that projection describes
 * an owner-READABLE attempt only — a `moderation_high` row never becomes one,
 * so no held message is reachable from here even by accident. The type-only
 * import below exists solely to pin `DeliveryStatus` and the content columns to
 * the read model's vocabulary; no attempt value crosses this boundary. Widening
 * these props to take the attempt would be the way the guarantee gets lost — the
 * projection is the choke point, so it stays upstream of this file.
 *
 * SEPARATE components rather than one with a `selectable` flag, so the
 * guarantee is shape rather than discipline — the same reasoning style as
 * `toRows`. No form renders an EDIT affordance (D22). Each serves a band of
 * **Batch states**. `SelectableAskList` serves the approvable one and renders
 * two per-ask controls — the exclude checkbox and the regenerate button (#860).
 * `WithdrawableAskList` (#872) is the THIRD and serves the approved-and-still-
 * live ones (`veto_window`/`approved`/`sending` — exactly the states the
 * **Halt latch** may still act on): the same read-only rows, plus ONE per-ask
 * withdraw control (**Ask withdrawal**) behind an inline two-tap confirm. An
 * approved batch is NOT yet a **Settled batch** — that needs no
 * `rendered`/`queued`/`sending` row left — and the withdraw control must exist
 * exactly while it is not. `AskList` serves the screens where the choosing is
 * over and nothing is left to act on — a batch the Halt latch has stopped, and
 * one that was ready with nothing sendable — and renders no control at all: it
 * has no toggle to call, no exclusion set to read and no arming to hold, so it
 * is structurally unable to offer one. That is the whole reason these are three
 * components rather than flags on one: past the live states the panel can only
 * render a list that cannot offer a control at all — or, once the batch is
 * closed, no list, only a count.
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

/** The resting label of the per-ask withdraw control (**Ask withdrawal**,
 *  #872). Plain English — unlike "halt" it needs no owner-facing carve-out. */
const WITHDRAW_LABEL = 'Withdraw';
/** The armed state's question. The pair below it is the only way to answer. */
const WITHDRAW_CONFIRM_PROMPT = 'Withdraw this message?';
const WITHDRAW_CONFIRM_LABEL = 'Withdraw';
const WITHDRAW_KEEP_LABEL = 'Keep';

/** Accessible names carry the contact (WCAG 2.5.3 Label in Name), like the
 *  regenerate control's. The confirm name is prefixed so a test — or a screen
 *  reader — can tell the armed control from the resting one. */
function withdrawControlName(contactName: string): string {
  return `${WITHDRAW_LABEL} the message to ${contactName}`;
}
function withdrawConfirmName(contactName: string): string {
  return `Confirm: withdraw the message to ${contactName}`;
}
function withdrawKeepName(contactName: string): string {
  return `Keep the message to ${contactName}`;
}

/**
 * The control's accessible name, derived from the label it is currently
 * showing.
 *
 * Two rules meet here and the old static `aria-label` broke both. It never
 * changed, so the swap to `REGENERATING_LABEL` was drawn on screen and silent
 * to assistive tech; and it did not contain the visible word, so WCAG 2.5.3
 * Label in Name (Level A) failed — a speech-input owner saying "click
 * Regenerate" could not activate it. The name is therefore BUILT FROM the
 * visible label rather than written beside it: it contains the label by
 * construction, and it moves when the label moves. The rest disambiguates the
 * one-control-per-ask list, which is why the label alone will not do.
 */
function regenerateControlName(regenerating: boolean, contactName: string): string {
  return regenerating
    ? `${REGENERATING_LABEL} of the message to ${contactName}`
    : `${REGENERATE_LABEL} the message to ${contactName}`;
}

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
        aria-label={regenerateControlName(regenerating, displayName(row))}
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

/** The same list on the read-only screens (halted, nothing left to send):
 *  names, statuses and the copy that was approved — no controls. A closed
 *  **Settled batch** shows a count, not this list. */
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

export interface WithdrawableAskListProps {
  /** Every non-cancelled attempt of the batch — the same rows the read-only
   *  list shows post-approval. Only `rendered`/`queued` rows get a control. */
  rows: readonly AskRowView[];
  /** The ONE ask whose control is armed (first tap taken), or null. Owned by
   *  the panel so a refetch that drops the row also drops the arming. */
  armedAskId: string | null;
  /** First tap: arm this ask (moves the arming if another was armed). */
  onArm: (askId: string) => void;
  /** Second tap: post the withdrawal. */
  onWithdraw: (askId: string) => void;
  /** Disarm without posting. */
  onKeep: () => void;
  /** True while any lane write is in flight. */
  disabled: boolean;
}

/**
 * The list once the batch is approved and still live: the same read-only rows,
 * plus ONE control per row that is still waiting to send — **Ask withdrawal**
 * (#872), behind an inline two-tap confirm because, unlike the pre-approval
 * checkbox, cancelling is terminal. Rows that are not `rendered`/`queued`
 * (withheld, sending, sent) render exactly as `AskList` renders them.
 *
 * A THIRD component rather than a flag on `AskList`, for `AskList`'s own
 * reason: the read-only list is structurally unable to offer a control, and it
 * must stay that way for the halted screen. The control itself, in both its
 * states, is `WithdrawControl` below.
 */
export function WithdrawableAskList({
  rows,
  armedAskId,
  onArm,
  onWithdraw,
  onKeep,
  disabled,
}: WithdrawableAskListProps) {
  if (rows.length === 0) return null;

  return (
    <ul className="rq-asks">
      {rows.map((row) => {
        const live = row.deliveryStatus === 'rendered' || row.deliveryStatus === 'queued';
        return (
          <li key={row.outreachId} className="rq-ask">
            <span className="rq-ask-name">{displayName(row)}</span>
            <span className="rq-ask-status">{STATUS_LABEL[row.deliveryStatus]}</span>
            {live && (
              <WithdrawControl
                row={row}
                armed={armedAskId === row.askId}
                disabled={disabled}
                onArm={onArm}
                onWithdraw={onWithdraw}
                onKeep={onKeep}
              />
            )}
            <AskMessage row={row} />
          </li>
        );
      })}
    </ul>
  );
}

/** The per-ask withdraw control in its two states — resting, or armed with the
 *  question and its two answers. Split out like `RegenerateControl`, so the
 *  list body reads "a live row gets the control" and the two-tap state lives
 *  in one place, rather than as two mutually exclusive guards over the same
 *  row. Both armed buttons are `btn-secondary`, like the **Halt latch**'s
 *  "Stop this batch": `.btn-danger` lives in `settings.css`, which the
 *  requests route never loads, so it would render here as a bare `.btn`. */
function WithdrawControl({
  row,
  armed,
  disabled,
  onArm,
  onWithdraw,
  onKeep,
}: {
  row: AskRowView;
  armed: boolean;
  disabled: boolean;
  onArm: (askId: string) => void;
  onWithdraw: (askId: string) => void;
  onKeep: () => void;
}) {
  if (!armed) {
    return (
      <span className="rq-ask-withdraw">
        <button
          type="button"
          className="btn btn-secondary rq-ask-withdraw-btn"
          onClick={() => onArm(row.askId)}
          disabled={disabled}
          aria-label={withdrawControlName(displayName(row))}
        >
          {WITHDRAW_LABEL}
        </button>
      </span>
    );
  }

  return (
    <span className="rq-ask-withdraw rq-ask-withdraw-armed" role="group">
      <span className="rq-ask-withdraw-prompt">{WITHDRAW_CONFIRM_PROMPT}</span>
      <button
        type="button"
        className="btn btn-secondary rq-ask-withdraw-btn"
        onClick={() => onWithdraw(row.askId)}
        disabled={disabled}
        aria-label={withdrawConfirmName(displayName(row))}
      >
        {WITHDRAW_CONFIRM_LABEL}
      </button>
      <button
        type="button"
        className="btn btn-secondary rq-ask-withdraw-btn"
        onClick={onKeep}
        disabled={disabled}
        aria-label={withdrawKeepName(displayName(row))}
      >
        {WITHDRAW_KEEP_LABEL}
      </button>
    </span>
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
