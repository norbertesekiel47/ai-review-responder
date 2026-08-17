'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type {
  ApproveBatchResult,
  HaltBatchResult,
  RequestAskRegenerationResult,
} from '@/lib/solicitation/approval';
import type {
  AskAttemptView,
  HaltReason,
  SendLaneView,
} from '@/lib/solicitation/batch-view';
import { ApprovalActions, type ApprovalVerb } from './ApprovalActions';
import { AskList, SelectableAskList, type AskRowView } from './AskList';
import './requests.css';

/**
 * The owner approval lane for a built Solicitation batch (#629).
 *
 * A client island owning exactly THREE things: which asks the owner has
 * deselected, whether a write is in flight, and the resulting error copy. It
 * renders from `sendLane` + `attempts` and never mutates the view it was given;
 * after every settled write it calls `onChanged(message, outcome)` and the
 * parent refetches through its existing `retry()`, so the fetch loop stays the
 * single owner of what is on screen.
 *
 * WHAT THE OWNER READS. Every rendered Outreach row is listed WITH its subject
 * and body (intake `user_visible_behavior[0]`). That is not decoration: the
 * 15-minute veto window is an undo rather than a review window *because* the
 * owner has already read every message they approved (CONTEXT.md "Owner
 * approval"), and a panel showing a name and a status would falsify the stated
 * basis for the short window. `toRows` carries the copy through.
 *
 * REDACTION (invariant #4 ported to the send lane; design D6a). The rule is
 * CONDITIONAL, and only the redacted half is a secret. A `moderation_high`
 * attempt is not owner-readable, so `toRows` drops it before any component can
 * touch it — its bytes reach neither markup nor a title/aria/data attribute nor
 * a React key — and it surfaces ONLY as the `sendLane.moderationWithheld` count
 * beside its reason. `toRows` is the ONE place an `AskAttemptView` is read
 * anywhere in the lane, and `AskRowView` — its projection — is the only shape
 * `AskList`/`SelectableAskList` accept, so the projection is where both halves
 * of the rule are decided. Handing a child the unprojected attempt is exactly
 * how the redacted half would be lost: if a child ever seems to need one, the
 * seam is wrong, not the projection.
 *
 * There is no edit affordance anywhere here, and that is still D22: the owner
 * may ask for new bytes, never write them. What changed at #860 is that asking
 * is now possible — the lane renders THREE kinds of control: the approve/stop
 * button in `ApprovalActions`, and per rendered ask, the exclude checkbox and
 * the regenerate button in `SelectableAskList`. Both per-ask controls are row
 * controls, not batch verbs, which is why `ApprovalVerb` still names two.
 */

const APPROVE_PATH = '/api/dashboard/solicitation/batch/approve';
const HALT_PATH = '/api/dashboard/solicitation/batch/halt';
const REGENERATE_PATH = '/api/dashboard/solicitation/batch/regenerate';

/** The redaction reason, as the owner sees it named. Verbatim, like the
 *  withhold-reason chips in BatchReport — the code is the thing support and the
 *  owner can both point at. */
const MODERATION_REASON = 'moderation_high';

/**
 * The lane's one projection, and the one place the conditional redaction rule
 * is applied.
 *
 * `redacted` rows are dropped outright: their count already rides
 * `sendLane.moderationWithheld`, which — with the reason — is the ONE thing the
 * owner is allowed to learn about them. Every surviving row carries its subject
 * and body, because those are exactly the rows the owner is being asked to
 * approve. The discriminant is checked here rather than trusted from the shape:
 * `AskRowView` has no redacted arm at all, so nothing downstream can render a
 * held message even if the read model regressed and handed one over with its
 * bytes attached.
 */
function toRows(attempts: AskAttemptView[]): AskRowView[] {
  const rows: AskRowView[] = [];
  for (const attempt of attempts) {
    if (attempt.redacted) continue;
    rows.push({
      outreachId: attempt.outreachId,
      askId: attempt.askId,
      attemptNo: attempt.attemptNo,
      contactName: attempt.contactName,
      deliveryStatus: attempt.deliveryStatus,
      subject: attempt.subject,
      body: attempt.body,
    });
  }
  return rows;
}

/**
 * The three Batch states that offer the stop control, named so `panelCopy`'s
 * haltable arm can be exhaustive over exactly them. A fourth state routed here
 * is then a compile error in BOTH places, instead of inheriting the `approved`
 * sentence and telling the owner nothing has left while it is sending.
 */
type HaltableState = Extract<
  SendLaneView['batchState'],
  'veto_window' | 'approved' | 'sending'
>;

type PanelMode =
  | { kind: 'preparing' }
  | { kind: 'approvable' }
  /** Ready, but nothing was written for anyone — no approve control (edge case 9). */
  | { kind: 'nothing_to_send' }
  | { kind: 'haltable'; state: HaltableState }
  | { kind: 'expired' }
  | { kind: 'halted' }
  | { kind: 'settled' };

/**
 * The render rule, in one place. Exhaustive over `BatchState` with no
 * `default`, so a new lifecycle state fails to compile here rather than
 * silently rendering the settled screen.
 *
 * `sendableRows` is a parameter rather than a second lane field because
 * readiness and sendability are different facts: readiness asks whether every
 * ask has a FINISHED attempt, and a withheld attempt is finished — so a batch
 * whose every attempt was withheld is vacuously `ready` with nothing to send.
 */
function panelMode(lane: SendLaneView, sendableRows: number): PanelMode {
  switch (lane.batchState) {
    case 'built':
      if (!lane.ready) return { kind: 'preparing' };
      return sendableRows > 0 ? { kind: 'approvable' } : { kind: 'nothing_to_send' };
    case 'veto_window':
    case 'approved':
    case 'sending':
      return { kind: 'haltable', state: lane.batchState };
    case 'expired':
      return { kind: 'expired' };
    case 'halted':
      return { kind: 'halted' };
    case 'closed':
    case 'pending':
      return { kind: 'settled' };
  }
}

/**
 * Which verb the mode offers, if any — the lifecycle half of the question
 * `ApprovalActions` answers visually. Exhaustive with no `default` for the same
 * reason as `panelMode`: a new mode has to state whether it is actionable,
 * rather than inheriting "no button" by omission.
 */
function actionVerb(mode: PanelMode): ApprovalVerb | null {
  switch (mode.kind) {
    case 'approvable':
      return 'approve';
    case 'haltable':
      return 'halt';
    case 'preparing':
    case 'nothing_to_send':
    case 'expired':
    case 'halted':
    case 'settled':
      return null;
  }
}

function countPhrase(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
}

/**
 * Exhaustive over the three haltable states, no `default` and no re-read of
 * `lane.batchState`: the state was decided by `panelMode` and travels on the
 * mode, so this cannot disagree with the control that is on screen.
 *
 * The veto window is an undo, not a review window, so every arm says what has
 * and has not left — never "review these before they send".
 */
function haltableBody(state: HaltableState): string {
  switch (state) {
    case 'veto_window':
      return 'Approved. Nothing has left yet, and you can still stop this batch.';
    case 'approved':
      return 'Approved and waiting to go out. Stopping cancels everything that has not left yet.';
    case 'sending':
      return 'These messages are going out now. Stopping cancels everything that has not left yet.';
  }
}

/**
 * Who stopped the batch, as the owner reads it. Total over `HaltReason` — the
 * READ side's union, which names all five writers of the one latch — so a sixth
 * reason is a tsc error here, and only the two reasons the owner can actually
 * cause say "you". The other three exist today with no owner entry point
 * (`admin_halt`) or no writer yet (#630's `send_window_elapsed`,
 * `batch_expired`); hard-coding "You stopped this batch" for all five is how
 * this screen would start lying the moment #630 lands.
 */
const HALT_BODY: Readonly<Record<HaltReason, string>> = {
  owner_veto: 'You stopped this batch before anything left. It cannot be resumed.',
  owner_halt:
    'You stopped this batch while it was sending. Whatever had already left has gone; nothing further will send.',
  admin_halt:
    'RepWorth support stopped this batch. It cannot be resumed — get in touch if that was not expected.',
  send_window_elapsed:
    'This batch ran out of time before everything went out, so the rest was cancelled. It cannot be resumed.',
  batch_expired:
    'This batch expired before it was approved, so it was stopped. Nothing was sent.',
};

/** The read model ASSERTS `halt_reason` against its CHECK rather than
 *  re-validating it, so a value from outside the union is possible in
 *  principle. It must read as a stop, never as a blank line. */
const UNKNOWN_HALT_BODY = 'This batch was stopped. It cannot be resumed.';

function haltedBody(reason: HaltReason | null): string {
  return reason !== null && Object.hasOwn(HALT_BODY, reason)
    ? HALT_BODY[reason]
    : UNKNOWN_HALT_BODY;
}

function panelCopy(mode: PanelMode, lane: SendLaneView): { heading: string; body: string } {
  switch (mode.kind) {
    case 'preparing':
      return {
        heading: 'Getting your messages ready',
        body: `Still preparing ${countPhrase(lane.pendingRenders)}. You can approve once every one of them is ready.`,
      };
    case 'approvable':
      return {
        heading: 'Ready for your approval',
        body: 'Read each message below — this is exactly what will be sent. Nothing sends until you approve. You can ask for a new version of any message, but you cannot write one yourself. Deselect anyone you would rather skip.',
      };
    case 'nothing_to_send':
      return {
        heading: 'Nothing to send in this batch',
        body: 'No message was written for anyone in this batch, so there is nothing to approve. The report below shows what was held back, and why.',
      };
    case 'haltable':
      return { heading: 'Approved', body: haltableBody(mode.state) };
    case 'expired':
      return {
        heading: 'This batch expired',
        body: 'This batch expired before it was approved. Nothing was sent.',
      };
    case 'halted':
      return { heading: 'This batch was stopped', body: haltedBody(lane.haltReason) };
    case 'settled':
      return {
        heading: 'This batch is finished',
        body: 'This batch is finished. Nothing more will send from it.',
      };
  }
}

// ── The exclusion set ───────────────────────────────────────────────────────

/** Exclusion is an act, not a default: an ASK id in the set is a deselected
 *  ask. Toggling a second time removes it again. */
function toggleExclusion(
  current: ReadonlySet<string>,
  askId: string,
): ReadonlySet<string> {
  const next = new Set(current);
  if (!next.delete(askId)) next.add(askId);
  return next;
}

/** How many sendable rows are still selected — the live count the approve
 *  button carries and the approved message repeats. */
function includedCount(
  rows: readonly AskRowView[],
  excluded: ReadonlySet<string>,
): number {
  return rows.reduce(
    (total, row) => (excluded.has(row.askId) ? total : total + 1),
    0,
  );
}

/**
 * The approve payload: the CURRENT outreach id of every deselected ask.
 *
 * The exclusion set is keyed on `askId` because that identity survives a
 * regeneration and an outreach id does not — a re-roll supersedes the row and
 * inserts a replacement under a new id. Resolving to outreach ids HERE, from
 * the rows this render is showing, means a regenerated ask stays excluded
 * under its new row instead of silently returning to the send list.
 *
 * An ask with no live row contributes nothing: there is no row left to cancel,
 * and sending a dead id would fail the whole approval `unknown_exclusion`.
 *
 * Exported for its property test — asserting this through a full render plus a
 * refetch would test the harness instead of the rule.
 */
export function excludedOutreachIds(
  rows: readonly AskRowView[],
  excludedAsks: ReadonlySet<string>,
): string[] {
  return rows
    .filter((row) => excludedAsks.has(row.askId))
    .map((row) => row.outreachId);
}

// ── The write ───────────────────────────────────────────────────────────────

/**
 * Every discriminant any of the three owner routes can answer with, taken from
 * the result unions themselves rather than re-spelled as strings here. That is
 * the whole point of the type: the record below is TOTAL over it, so a new
 * refusal added to `ApproveBatchResult`, `HaltBatchResult` or
 * `RequestAskRegenerationResult` is a tsc error in this file instead of
 * silently degrading to the generic copy.
 */
type LaneStatus =
  | ApproveBatchResult['status']
  | HaltBatchResult['status']
  | RequestAskRegenerationResult['status'];

/**
 * What the owner reads when a write did not settle as done. `null` marks the
 * statuses a 2xx carries: those settled, and the verb's own sentence speaks for
 * them, so they have no refusal copy to give.
 *
 * "Nothing was approved" is safe to say in every arm here because a refusal IS
 * a refusal: `approveBatch` validates the exclusion list BEFORE it writes
 * anything, so a 400/409 leaves the batch untouched. The uncertain case is the
 * `unconfirmed` outcome below, and it deliberately claims nothing.
 */
const LANE_REFUSAL_COPY: Readonly<Record<LaneStatus, string | null>> = {
  approved: null,
  already_approved: null,
  halted: null,
  already_halted: null,
  not_ready:
    'Some messages are still being prepared. Nothing was approved — try again in a moment.',
  not_approvable:
    'This batch can no longer be approved. Reload the page to see where it stands.',
  unknown_exclusion:
    'We could not match one of the people you deselected. Nothing was approved.',
  not_haltable: 'This batch has already finished. There is nothing left to stop.',
  not_found: 'We could not find this batch any more. Reload the page to see where it stands.',
  // 202 Accepted — the work was taken, not done, so there is nothing to refuse.
  accepted: null,
  already_in_flight:
    'We are already writing a new version for this batch. Wait for it to finish, then try again.',
  not_regenerable:
    'This batch has been approved, so its messages can no longer be changed. Stop the batch if you need to.',
  ask_not_regenerable:
    'We cannot write a new version of this message. Nothing changed.',
  // Reached only if the 429 body ever loses its `message`; the server's own
  // sentence wins when present (`postLaneAction` reads it).
  budget_exhausted:
    'You have reached today\'s limit for new versions of this message. You can ask again tomorrow.',
};

/** A discriminant this build knows, or null for anything else on the wire — a
 *  server deployed ahead of the browser is a real case, and `in`-checking the
 *  record's OWN keys keeps `toString` and friends off the lookup path. */
function toLaneStatus(value: unknown): LaneStatus | null {
  return typeof value === 'string' && Object.hasOwn(LANE_REFUSAL_COPY, value)
    ? (value as LaneStatus)
    : null;
}

type LaneOutcome =
  /** The server settled the request: 2xx, carrying its result discriminant. */
  | { kind: 'done'; status: LaneStatus | null }
  /**
   * The server refused with a reason worth repeating (400 / 409 / 429).
   * `message` is the server's OWN sentence when it wrote one — the 429 body
   * carries no `status`, so without it an exhausted budget would fall through
   * to the generic copy.
   */
  | { kind: 'refused'; status: LaneStatus | null; message: string | null }
  /**
   * The client never read an answer: transport failure, or a response whose
   * body carries no discriminant. NOT a failure — the transaction may already
   * have committed, in which case the batch is approved and its veto clock is
   * running. The one thing that is certainly wrong here is "nothing changed".
   */
  | { kind: 'unconfirmed' };

const GENERIC_REFUSAL = 'Something went wrong. Nothing changed — try again.';

/** Deliberately claims nothing about the write. The refetch it triggers is what
 *  answers the question, and both verbs are safe to repeat: approval is CAS'd
 *  on `approved_at IS NULL` and the Halt latch is monotone. */
const UNCONFIRMED_OUTCOME =
  'We could not confirm whether that went through. Reloading the batch now — check the state below before trying again.';

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
    // 400, 409 and 429 are the refusals that carry a body worth reading; every
    // other non-2xx is `errorResponse`, whose body says nothing about whether
    // the transaction committed. So it is unconfirmed, not failed.
    //
    // 429 is the ask-regenerate budget arm and it is a DEFINITE refusal, so it
    // must not fall through to `unconfirmed`, whose whole purpose is to admit
    // that the write may have committed. Its body is
    // `{ error, message, remaining, limit }` and carries no `status`, so
    // `toLaneStatus` yields null and the server's `message` is what the owner
    // reads.
    if (response.ok || [400, 409, 429].includes(response.status)) {
      const result = (await response.json()) as { status?: unknown; message?: unknown };
      const status = toLaneStatus(result.status);
      const message = typeof result.message === 'string' ? result.message : null;
      return response.ok
        ? { kind: 'done', status }
        : { kind: 'refused', status, message };
    }
    console.error(`[requests] lane action answered ${response.status}`);
    return { kind: 'unconfirmed' };
  } catch (error) {
    console.error('[requests] lane action could not reach the server', error);
    return { kind: 'unconfirmed' };
  }
}

/** The copy for a refusal. The server's own sentence wins when it wrote one —
 *  it knows facts this table cannot carry, such as the daily cap. Otherwise a
 *  status outside this build's union, or one whose arm is `null`, is still a
 *  refusal — the server validated and declined — so the generic sentence may
 *  honestly say nothing changed. */
function refusalCopy(status: LaneStatus | null, message: string | null): string {
  if (message !== null) return message;
  return (status === null ? null : LANE_REFUSAL_COPY[status]) ?? GENERIC_REFUSAL;
}

/** The sentence the parent announces, from the route's result discriminant. */
type Announce = (status: LaneStatus | null) => string;

/** The approve sentence. The count is bound here so the shared settle path
 *  below stays free of either route's copy. */
function approvedAnnounce(sendCount: number): Announce {
  return (status) =>
    status === 'already_approved'
      ? 'This batch was already approved.'
      : `Approved. ${countPhrase(sendCount)} will send. You can still stop this batch.`;
}

/** A regeneration is accepted, not done. The sentence must not describe a
 *  result the server has not produced. */
const regenerateAnnounce: Announce = (status) =>
  status === 'accepted'
    ? 'Writing a new version. It will replace the message below in a moment.'
    : 'Nothing changed.';

/** The halt sentence. Both routes are idempotent, so each has an "already" arm
 *  that must not claim anything new happened. */
const haltedAnnounce: Announce = (status) =>
  status === 'already_halted'
    ? 'This batch was already stopped.'
    : 'Batch stopped. Nothing further will send.';

/**
 * How a write ended, for the parent. `settled` means the server answered and
 * the sentence describes what it did; `unconfirmed` means the sentence describes
 * only that we do not know — the parent refetches either way, but must not
 * present the second as a report of what happened.
 */
export type LaneWriteOutcome = 'settled' | 'unconfirmed';

interface LaneWriteInputs {
  batchId: string;
  /** The location scope the view was read for — the write must name the same
   *  location, or it lands on the owner's default one. */
  scope: string;
  /** The CURRENT outreach ids of the deselected asks — the approve payload,
   *  resolved from the rows on screen by `excludedOutreachIds`. */
  excludedIds: readonly string[];
  /** Only for the approve sentence — the server recounts under its own lock. */
  sendCount: number;
  onChanged: (message: string, outcome: LaneWriteOutcome) => void;
}

interface LaneWrites {
  /** True while any of the three writes is in flight. */
  busy: boolean;
  /** Copy for the last write the server REFUSED; '' when there is none. */
  error: string;
  approve: () => void;
  halt: () => void;
  regenerate: (askId: string) => void;
}

/**
 * The lane's three writes and the two pieces of state they own.
 *
 * They settle identically — busy on, error cleared, POST, busy off, then either
 * the parent's announcement or the refusal copy — and differ only in route,
 * body, and sentence, so `perform` is the one settle path. Nothing here
 * refetches: `onChanged` is the parent's cue to run its existing `retry()`.
 */
function useLaneWrites({
  batchId,
  scope,
  excludedIds,
  sendCount,
  onChanged,
}: LaneWriteInputs): LaneWrites {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const perform = useCallback(
    async (path: string, requestBody: Record<string, unknown>, announce: Announce) => {
      setBusy(true);
      setError('');
      const outcome = await postLaneAction(path, scope, requestBody);
      setBusy(false);
      if (outcome.kind === 'refused') {
        setError(refusalCopy(outcome.status, outcome.message));
        return;
      }
      // An unconfirmed outcome is handed UP rather than shown here, and the
      // difference is not cosmetic: the batch may be approved with its veto
      // clock already running, so the only honest next screen is the server's
      // own state. The parent refetches, and the panel this error box belongs
      // to is replaced by whatever is actually true.
      if (outcome.kind === 'unconfirmed') {
        onChanged(UNCONFIRMED_OUTCOME, 'unconfirmed');
        return;
      }
      onChanged(announce(outcome.status), 'settled');
    },
    [onChanged, scope],
  );

  const approve = useCallback(() => {
    void perform(
      APPROVE_PATH,
      { batchId, excludedOutreachIds: [...excludedIds] },
      approvedAnnounce(sendCount),
    );
  }, [batchId, excludedIds, perform, sendCount]);

  // The halt body carries ONLY the batch id: the halt reason is derived
  // server-side so the audit trail cannot be told what to say.
  const halt = useCallback(() => {
    void perform(HALT_PATH, { batchId }, haltedAnnounce);
  }, [batchId, perform]);

  const regenerate = useCallback(
    (askId: string) => {
      // Same settle path as the other two, different sentence: the other verbs
      // announce a completed act and this one is 202 Accepted. The sentence
      // says what was ASKED for; the poll loop reports what happened.
      void perform(REGENERATE_PATH, { batchId, askId }, regenerateAnnounce);
    },
    [batchId, perform],
  );

  return { busy, error, approve, halt, regenerate };
}

// ── The panel ───────────────────────────────────────────────────────────────

export interface ApprovalPanelProps {
  batchId: string;
  sendLane: SendLaneView;
  attempts: AskAttemptView[];
  /** The location scope the view was read for — the write must name the same
   *  location, or it lands on the owner's default one. */
  scope: string;
  /** Called after every write that left the panel, with the sentence to
   *  announce and whether that sentence is a report or an admission. The parent
   *  turns both into its existing refetch. */
  onChanged: (message: string, outcome: LaneWriteOutcome) => void;
}

export function ApprovalPanel({
  batchId,
  sendLane,
  attempts,
  scope,
  onChanged,
}: ApprovalPanelProps) {
  // Keyed on ASK id, not outreach id, and there is deliberately no pruning
  // effect: an ask's identity survives a regeneration, so a deselection does
  // too, and a stale ask id resolves to no row and drops out of the payload by
  // construction (`excludedOutreachIds`). The pruning this plan carried at
  // round 1 stopped an `unknown_exclusion` crash but silently RE-SELECTED the
  // contact, which could send a message the owner had deselected.
  const [excludedAsks, setExcludedAsks] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  /** The ask this panel asked to regenerate, and the attempt number it carried
   *  when we asked. Both halves are needed by the settle effect below: the
   *  first says which row to look at, the second is how a landed regeneration
   *  is told from one that settled without changing anything. */
  const pendingRegen = useRef<{ askId: string; attemptNo: number } | null>(null);

  const rows = useMemo(() => toRows(attempts), [attempts]);
  const sendable = useMemo(
    () => rows.filter((row) => row.deliveryStatus === 'rendered'),
    [rows],
  );

  // Sendability, not readiness: an all-withheld batch is `ready` with nothing
  // to approve, and must not be offered a control that would send 0 messages.
  const mode = panelMode(sendLane, sendable.length);
  const { heading, body } = panelCopy(mode, sendLane);
  const sendCount = includedCount(sendable, excludedAsks);
  const excludedIds = useMemo(
    () => excludedOutreachIds(sendable, excludedAsks),
    [sendable, excludedAsks],
  );

  const toggle = useCallback((askId: string) => {
    setExcludedAsks((current) => toggleExclusion(current, askId));
  }, []);

  const { busy, error, approve, halt, regenerate } = useLaneWrites({
    batchId,
    scope,
    excludedIds,
    sendCount,
    onChanged,
  });

  const onRegenerate = useCallback(
    (askId: string) => {
      const row = sendable.find((candidate) => candidate.askId === askId);
      // The control only exists for rows in `sendable`, so an absent row means
      // the list moved underneath the click. Ask anyway — the server decides —
      // but record no pending entry, because there is no attempt number to
      // compare a settlement against.
      pendingRegen.current =
        row === undefined ? null : { askId, attemptNo: row.attemptNo };
      regenerate(askId);
    },
    [regenerate, sendable],
  );

  /**
   * A worker-side refusal (budget race, subscription lapse, a swap that lost
   * its re-check) completes the outbox row and leaves the copy untouched. The
   * spinner would simply stop and the same words would still be on screen,
   * which reads as "nothing happened" — so say it.
   *
   * Deliberately NOT gated on having observed a non-null `regeneratingAskId`:
   * a fast worker can finish between the 202 and the first poll, and outcome
   * reporting must not depend on the panel having caught the in-flight state
   * (codex round 1, finding 10).
   */
  useEffect(() => {
    const pending = pendingRegen.current;
    if (pending === null || sendLane.regeneratingAskId !== null) return;
    pendingRegen.current = null;
    const row = sendable.find((candidate) => candidate.askId === pending.askId);
    if (row !== undefined && row.attemptNo === pending.attemptNo) {
      onChanged(
        'We could not write a new version. The message below is unchanged.',
        'settled',
      );
    }
  }, [sendLane.regeneratingAskId, sendable, onChanged]);

  // Server-authoritative: `regeneratingAskId` is read from the in-flight
  // `job_outbox` row, so a second tab is held too. Approving mid-flight is safe
  // — the swap's locked re-check refuses and only the spend is lost — but it
  // silently throws away work the owner asked for.
  const regenerating = sendLane.regeneratingAskId !== null;

  return (
    <section
      className="card section-enter section-enter-1 rq-approval"
      aria-labelledby="rq-approval-heading"
    >
      <h2 className="card-h2" id="rq-approval-heading">
        {heading}
      </h2>
      <p className="rq-state-body">{body}</p>

      {mode.kind === 'approvable' && (
        <SelectableAskList
          rows={sendable}
          excluded={excludedAsks}
          onToggle={toggle}
          disabled={busy}
          regenBudgets={sendLane.regenBudgets}
          regeneratingAskId={sendLane.regeneratingAskId}
          onRegenerate={onRegenerate}
        />
      )}

      {(mode.kind === 'haltable' ||
        mode.kind === 'halted' ||
        mode.kind === 'nothing_to_send') && <AskList rows={rows} />}

      {mode.kind === 'settled' && (
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

      <ApprovalActions
        verb={actionVerb(mode)}
        busy={busy}
        unavailable={regenerating}
        sendPhrase={countPhrase(sendCount)}
        onApprove={approve}
        onHalt={halt}
      />
    </section>
  );
}
