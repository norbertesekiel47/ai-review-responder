'use client';

import type { AskAttemptView } from '@/lib/solicitation/batch-view';
import './requests.css';

/**
 * The owner approval lane's ask list (#629), in its two forms.
 *
 * REDACTION (invariant #4 ported to the send lane; design D6a). Nothing here
 * ever holds an `AskAttemptView`: both components take `AskRowView`, the
 * projection `ApprovalPanel`'s `toRows` produces — an id, a name, and a status,
 * and nothing else. The type-only import below exists solely to pin
 * `DeliveryStatus` to migration 091's vocabulary; no attempt value crosses this
 * boundary, so no `subject` or `body` is reachable from here even by accident.
 * Widening these props to take the attempt would be the way that guarantee gets
 * lost — the projection is the choke point, so it goes upstream of this file.
 *
 * TWO components rather than one with a `selectable` flag: an approved batch is
 * settled, and `AskList` is structurally unable to offer a control because it
 * has no toggle to call and no exclusion set to read. Same reasoning style as
 * `toRows` — make the guarantee shape rather than discipline. Neither form
 * renders an edit or a regenerate affordance (D22).
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

/**
 * One list row. Deliberately NOT the attempt itself — projecting first is what
 * makes the redaction rule structural instead of a habit: nothing downstream of
 * `toRows` can reach a rendered message even by accident.
 */
export interface AskRowView {
  outreachId: string;
  contactName: string;
  deliveryStatus: DeliveryStatus;
}

export interface SelectableAskListProps {
  /** The rows the owner may still deselect — `rendered` asks only, because
   *  `rendered` is the one status the approve route accepts an exclusion for. */
  rows: readonly AskRowView[];
  /** Outreach ids the owner has deselected. Exclusion is an act, not a default,
   *  so an empty set means "send to everyone in the list". */
  excluded: ReadonlySet<string>;
  onToggle: (outreachId: string) => void;
  /** True while a write is in flight. */
  disabled: boolean;
}

/** The list while the owner is still choosing: one checkbox per sendable ask. */
export function SelectableAskList({
  rows,
  excluded,
  onToggle,
  disabled,
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
              checked={!excluded.has(row.outreachId)}
              onChange={() => onToggle(row.outreachId)}
              disabled={disabled}
            />
            <span className="rq-ask-name">Send to {displayName(row)}</span>
          </label>
          <span className="rq-ask-status">{STATUS_LABEL[row.deliveryStatus]}</span>
        </li>
      ))}
    </ul>
  );
}

/** The same list once the batch is settled: names and statuses, no controls. */
export function AskList({ rows }: { rows: readonly AskRowView[] }) {
  if (rows.length === 0) return null;

  return (
    <ul className="rq-asks">
      {rows.map((row) => (
        <li key={row.outreachId} className="rq-ask">
          <span className="rq-ask-name">{displayName(row)}</span>
          <span className="rq-ask-status">{STATUS_LABEL[row.deliveryStatus]}</span>
        </li>
      ))}
    </ul>
  );
}

/** `solicitation_contacts.name` is nullable-ish TEXT upstream; an empty string
 *  must still produce a usable checkbox label. */
function displayName(row: AskRowView): string {
  return row.contactName || 'Unnamed contact';
}
