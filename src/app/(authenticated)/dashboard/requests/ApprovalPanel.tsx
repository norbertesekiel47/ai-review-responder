'use client';

import { useCallback, useMemo, useState } from 'react';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type { AskAttemptView, SendLaneView } from '@/lib/solicitation/batch-view';
import './requests.css';

/**
 * The owner approval lane for a built Solicitation batch (#629).
 *
 * A client island owning exactly THREE things: which asks the owner has
 * deselected, whether a write is in flight, and the resulting error copy. It
 * renders from `sendLane` + `attempts` and never mutates the view it was given;
 * after every settled write it calls `onChanged(message)` and the parent
 * refetches through its existing `retry()`, so the fetch loop stays the single
 * owner of what is on screen.
 *
 * REDACTION (invariant #4 ported to the send lane; design D6a). A
 * `moderation_high` attempt is not owner-readable, and this component is
 * structurally unable to leak it: `toRows` drops every `redacted` attempt AND
 * projects the survivors onto {id, name, status}, so no attempt's `subject` or
 * `body` is read anywhere below — not into markup, not into a title/aria/data
 * attribute, not into a key. (`body` below is only ever this panel's own prose
 * or a request body.) The held rows surface as a reason plus the
 * `sendLane.moderationWithheld` count, and nothing else.
 *
 * There is no edit affordance and no regenerate control anywhere here (D22).
 * Approve or exclude, and nothing else.
 */

const APPROVE_PATH = '/api/dashboard/solicitation/batch/approve';
const HALT_PATH = '/api/dashboard/solicitation/batch/halt';

/** The redaction reason, as the owner sees it named. Verbatim, like the
 *  withhold-reason chips in BatchReport — the code is the thing support and the
 *  owner can both point at. */
const MODERATION_REASON = 'moderation_high';

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
interface AskRowView {
  outreachId: string;
  contactName: string;
  deliveryStatus: DeliveryStatus;
}

/**
 * `redacted` rows are dropped outright, not rendered with their reason: their
 * count already rides `sendLane.moderationWithheld`, which is the ONE thing the
 * owner is allowed to learn about them. The filter is belt-and-braces — 091's
 * status↔reason CHECK means a `moderation_high` row is always `withheld`, never
 * `rendered` — but it costs nothing and removes the whole class of leak.
 */
function toRows(attempts: AskAttemptView[]): AskRowView[] {
  return attempts
    .filter((attempt) => !attempt.redacted)
    .map((attempt) => ({
      outreachId: attempt.outreachId,
      contactName: attempt.contactName,
      deliveryStatus: attempt.deliveryStatus,
    }));
}

type PanelMode =
  | 'preparing'
  | 'approvable'
  | 'stoppable'
  | 'expired'
  | 'halted'
  | 'settled';

/**
 * The render rule, in one place. Exhaustive over `BatchState` with no
 * `default`, so a new lifecycle state fails to compile here rather than
 * silently rendering the settled screen.
 */
function panelMode(lane: SendLaneView): PanelMode {
  switch (lane.batchState) {
    case 'built':
      return lane.ready ? 'approvable' : 'preparing';
    case 'veto_window':
    case 'approved':
    case 'sending':
      return 'stoppable';
    case 'expired':
      return 'expired';
    case 'halted':
      return 'halted';
    case 'closed':
    case 'pending':
      return 'settled';
  }
}

function countPhrase(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
}

function panelCopy(mode: PanelMode, lane: SendLaneView): { heading: string; body: string } {
  switch (mode) {
    case 'preparing':
      return {
        heading: 'Getting your messages ready',
        body: `Still preparing ${countPhrase(lane.pendingRenders)}. You can approve once every one of them is ready.`,
      };
    case 'approvable':
      return {
        heading: 'Ready for your approval',
        body: 'Nothing sends until you approve. Deselect anyone you would rather skip — messages cannot be edited here.',
      };
    case 'stoppable':
      return {
        heading: 'Approved',
        // The veto window is an undo, not a review window: the copy says what
        // has and has not left, never "review these before they send".
        body:
          lane.batchState === 'veto_window'
            ? 'Approved. Nothing has left yet, and you can still stop this batch.'
            : lane.batchState === 'sending'
              ? 'These messages are going out now. Stopping cancels everything that has not left yet.'
              : 'Approved and waiting to go out. Stopping cancels everything that has not left yet.',
      };
    case 'expired':
      return {
        heading: 'This batch expired',
        body: 'This batch expired before it was approved. Nothing was sent.',
      };
    case 'halted':
      return {
        heading: 'You stopped this batch',
        body: 'You stopped this batch. It cannot be resumed.',
      };
    case 'settled':
      return {
        heading: 'This batch is finished',
        body: 'This batch is finished. Nothing more will send from it.',
      };
  }
}

// ── The write ───────────────────────────────────────────────────────────────

type LaneOutcome =
  /** The server settled the request: 2xx, carrying its result discriminant. */
  | { kind: 'done'; status: string }
  /** The server refused with a reason worth repeating (400 / 409). */
  | { kind: 'refused'; status: string }
  /** Anything else, including transport failure. */
  | { kind: 'failed' };

/** Refusals the owner can act on. Anything unmapped degrades to the generic
 *  copy rather than surfacing a raw discriminant. */
const REFUSAL_COPY: Record<string, string> = {
  not_ready:
    'Some messages are still being prepared. Nothing was approved — try again in a moment.',
  not_approvable:
    'This batch can no longer be approved. Reload the page to see where it stands.',
  unknown_exclusion:
    'We could not match one of the people you deselected. Nothing was approved.',
  not_haltable: 'This batch has already finished. There is nothing left to stop.',
};

const GENERIC_FAILURE = 'Something went wrong. Nothing changed — try again.';

async function postLaneAction(
  path: string,
  scope: string,
  body: Record<string, unknown>,
): Promise<LaneOutcome> {
  try {
    const response = await fetch(withSolicitationScope(path, scope), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 400 and 409 are the only refusals that carry a result discriminant; every
    // other non-2xx is `errorResponse`, whose body says nothing useful here.
    if (response.ok || response.status === 400 || response.status === 409) {
      const result = (await response.json()) as { status?: unknown };
      const status = typeof result.status === 'string' ? result.status : '';
      return response.ok ? { kind: 'done', status } : { kind: 'refused', status };
    }
    console.error(`[requests] lane action failed with ${response.status}`);
    return { kind: 'failed' };
  } catch (error) {
    console.error('[requests] lane action could not reach the server', error);
    return { kind: 'failed' };
  }
}

// ── The panel ───────────────────────────────────────────────────────────────

export interface ApprovalPanelProps {
  batchId: string;
  sendLane: SendLaneView;
  attempts: AskAttemptView[];
  /** The location scope the view was read for — the write must name the same
   *  location, or it lands on the owner's default one. */
  scope: string;
  /** Called after every settled write, with the sentence to announce. The
   *  parent turns this into its existing refetch. */
  onChanged: (message: string) => void;
}

export function ApprovalPanel({
  batchId,
  sendLane,
  attempts,
  scope,
  onChanged,
}: ApprovalPanelProps) {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const rows = useMemo(() => toRows(attempts), [attempts]);
  const sendable = useMemo(
    () => rows.filter((row) => row.deliveryStatus === 'rendered'),
    [rows],
  );

  const mode = panelMode(sendLane);
  const { heading, body } = panelCopy(mode, sendLane);
  const sendCount = sendable.reduce(
    (total, row) => (excluded.has(row.outreachId) ? total : total + 1),
    0,
  );

  const toggle = useCallback((outreachId: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (!next.delete(outreachId)) next.add(outreachId);
      return next;
    });
  }, []);

  const approve = useCallback(async () => {
    setBusy(true);
    setError('');
    const outcome = await postLaneAction(APPROVE_PATH, scope, {
      batchId,
      excludedOutreachIds: [...excluded],
    });
    setBusy(false);
    if (outcome.kind !== 'done') {
      setError(
        outcome.kind === 'refused'
          ? (REFUSAL_COPY[outcome.status] ?? GENERIC_FAILURE)
          : GENERIC_FAILURE,
      );
      return;
    }
    onChanged(
      outcome.status === 'already_approved'
        ? 'This batch was already approved.'
        : `Approved. ${countPhrase(sendCount)} will send. You can still stop this batch.`,
    );
  }, [batchId, excluded, onChanged, scope, sendCount]);

  const halt = useCallback(async () => {
    setBusy(true);
    setError('');
    // Body carries ONLY the batch id: the halt reason is derived server-side so
    // the audit trail cannot be told what to say.
    const outcome = await postLaneAction(HALT_PATH, scope, { batchId });
    setBusy(false);
    if (outcome.kind !== 'done') {
      setError(
        outcome.kind === 'refused'
          ? (REFUSAL_COPY[outcome.status] ?? GENERIC_FAILURE)
          : GENERIC_FAILURE,
      );
      return;
    }
    onChanged(
      outcome.status === 'already_halted'
        ? 'This batch was already stopped.'
        : 'Batch stopped. Nothing further will send.',
    );
  }, [batchId, onChanged, scope]);

  return (
    <section
      className="card section-enter section-enter-1 rq-approval"
      aria-labelledby="rq-approval-heading"
    >
      <h2 className="card-h2" id="rq-approval-heading">
        {heading}
      </h2>
      <p className="rq-state-body">{body}</p>

      {mode === 'approvable' && sendable.length > 0 && (
        <ul className="rq-asks">
          {sendable.map((row) => (
            <li key={row.outreachId} className="rq-ask">
              <label className="rq-ask-label">
                <input
                  type="checkbox"
                  className="rq-ask-check"
                  checked={!excluded.has(row.outreachId)}
                  onChange={() => toggle(row.outreachId)}
                  disabled={busy}
                />
                <span className="rq-ask-name">Send to {displayName(row)}</span>
              </label>
              <span className="rq-ask-status">{STATUS_LABEL[row.deliveryStatus]}</span>
            </li>
          ))}
        </ul>
      )}

      {(mode === 'stoppable' || mode === 'halted') && rows.length > 0 && (
        <ul className="rq-asks">
          {rows.map((row) => (
            <li key={row.outreachId} className="rq-ask">
              <span className="rq-ask-name">{displayName(row)}</span>
              <span className="rq-ask-status">{STATUS_LABEL[row.deliveryStatus]}</span>
            </li>
          ))}
        </ul>
      )}

      {mode === 'settled' && (
        <p className="rq-approval-summary">{countPhrase(rows.length)} in this batch.</p>
      )}

      {sendLane.moderationWithheld > 0 && (
        <p className="rq-approval-note">
          <span className="rq-chip rq-chip--hold">{MODERATION_REASON}</span>{' '}
          {countPhrase(sendLane.moderationWithheld)} held by the safety check. They
          are not sent, and their text is not shown here.
        </p>
      )}

      {error !== '' && (
        <p className="rq-approval-error" role="alert">
          {error}
        </p>
      )}

      {mode === 'approvable' && (
        <div className="rq-approval-actions">
          <button
            type="button"
            className="btn btn-primary rq-action"
            onClick={() => void approve()}
            disabled={busy}
          >
            {busy ? 'Approving…' : `Approve and send ${countPhrase(sendCount)}`}
          </button>
        </div>
      )}

      {mode === 'stoppable' && (
        <div className="rq-approval-actions">
          <button
            type="button"
            className="btn btn-secondary rq-action"
            onClick={() => void halt()}
            disabled={busy}
          >
            {busy ? 'Stopping…' : 'Stop this batch'}
          </button>
        </div>
      )}
    </section>
  );
}

/** `solicitation_contacts.name` is nullable-ish TEXT upstream; an empty string
 *  must still produce a usable checkbox label. */
function displayName(row: AskRowView): string {
  return row.contactName || 'Unnamed contact';
}
