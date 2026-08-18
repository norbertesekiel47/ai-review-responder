'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type {
  ApproveBatchResult,
  HaltBatchResult,
  RequestAskRegenerationResult,
  WithdrawAskResult,
} from '@/lib/solicitation/approval';
import type {
  AskAttemptView,
  HaltReason,
  SendLaneView,
} from '@/lib/solicitation/batch-view';
import { ApprovalActions, type ApprovalVerb } from './ApprovalActions';
import {
  AskList,
  SelectableAskList,
  WithdrawableAskList,
  type AskRowView,
} from './AskList';
import './requests.css';

/**
 * The owner approval lane for a built Solicitation batch (#629).
 *
 * A client island owning exactly FOUR things: which asks the owner has
 * deselected (`useExcludedAsks`), whether a write is in flight and the
 * resulting error copy (`useLaneWrites`), what this panel last asked to
 * regenerate (`usePendingRegeneration`), and which ask's withdraw control is
 * armed (`armedAskId`, #872 — held in the panel and cleared the moment a
 * refetch drops the row). It renders from `sendLane` + `attempts` and never
 * mutates the view it was given; after every settled write it calls
 * `onChanged(message, outcome, refresh)` and the parent refetches, so the fetch
 * loop stays the single owner of what is on screen.
 *
 * TWO of the four writes are TERMINAL and two are not, and the difference is
 * carried on the wire out rather than assumed. Approve and stop end this panel;
 * the parent may tear it down. A regeneration or a withdrawal comes BACK here —
 * same batch, same list, same owner mid-task — so each asks for a refetch that
 * keeps this component mounted (`LaneRefresh`). None of that state survives a
 * remount: the exclusion set and the armed withdraw are `useState` and the
 * pending-regeneration marker is a `useRef`, so routing a non-terminal write
 * through the terminal path re-selected every deselected ask and made the
 * unchanged-copy report unreachable.
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
 * is now possible — the lane renders FOUR kinds of control: the approve/stop
 * button in `ApprovalActions`; per rendered ask before approval, the exclude
 * checkbox and the regenerate button in `SelectableAskList`; and per live ask
 * AFTER approval, the withdraw control in `WithdrawableAskList` (**Ask
 * withdrawal**, #872). All three per-ask controls are row controls, not batch
 * verbs, which is why `ApprovalVerb` still names two.
 */

const APPROVE_PATH = '/api/dashboard/solicitation/batch/approve';
const HALT_PATH = '/api/dashboard/solicitation/batch/halt';
const REGENERATE_PATH = '/api/dashboard/solicitation/batch/regenerate';
const WITHDRAW_PATH = '/api/dashboard/solicitation/batch/withdraw';

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
 * The other half of the same rule, and the only half the owner ever reads.
 *
 * `toRows` above drops a held attempt outright; everything the owner is allowed
 * to learn about the ones it dropped is here — how many there were, and the
 * reason code verbatim. Rendering nothing at zero is deliberate: a batch with no
 * held message must not carry a note about held messages, and the count is the
 * only thing that could ever distinguish the two.
 */
function ModerationWithheldNote({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <p className="rq-approval-note">
      <span className="rq-chip rq-chip--hold">{MODERATION_REASON}</span>{' '}
      {countPhrase(count)} held by the safety check. They are not sent, and their
      text is not shown here.
    </p>
  );
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

/**
 * How a mode shows the batch's asks — the third facet `PanelMode` decides,
 * beside `panelCopy`'s words and `actionVerb`'s button.
 *
 * `selectable` — the owner is still choosing, so every sendable ask gets its
 *   two row controls. `withdrawable` — approved and still live: the owner may
 *   withdraw single messages (#872). `read_only` — the choosing is over and the
 *   messages are still what the owner needs to see. `count` — a settled batch,
 *   where the messages are history and only how many there were still says
 *   something. `none` — there is nothing to show yet, or nothing was ever
 *   written.
 *
 * Exhaustive with no `default`, for the same reason as `actionVerb`. The three
 * arms were three independent `mode.kind === …` guards in the markup: mutually
 * exclusive only by coincidence, and a new mode inherited a blank panel by
 * omission rather than failing to compile.
 */
type AskDisplay = 'selectable' | 'withdrawable' | 'read_only' | 'count' | 'none';

function askDisplay(mode: PanelMode): AskDisplay {
  switch (mode.kind) {
    case 'approvable':
      return 'selectable';
    case 'haltable':
      return 'withdrawable';
    case 'halted':
    case 'nothing_to_send':
      return 'read_only';
    case 'settled':
      return 'count';
    case 'preparing':
    case 'expired':
      return 'none';
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
      return 'Approved. Nothing has left yet, and you can still stop this batch or withdraw a single message.';
    case 'approved':
      return 'Approved and waiting to go out. Stopping cancels everything that has not left yet; you can also withdraw a single message.';
    case 'sending':
      return 'These messages are going out now. Stopping cancels everything that has not left yet; you can also withdraw a single message that has not left.';
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
 * regeneration and an outreach id does not — a regeneration supersedes the row
 * and inserts a replacement under a new id. Resolving to outreach ids HERE, from
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

interface ExcludedAsks {
  /** The deselected ASK ids. Empty means "send to everyone in the list". */
  excluded: ReadonlySet<string>;
  /** Flip one ask out of the send list, or back into it. */
  toggle: (askId: string) => void;
  /** The approve payload — `excludedOutreachIds` over the rows on screen. */
  excludedIds: readonly string[];
  /** How many of those rows are still selected — the count the approve button
   *  carries and the approved message repeats. */
  sendCount: number;
}

/**
 * The exclusion set as the panel holds it: the deselections themselves, the one
 * verb that changes them, and the two facts every render and every approve
 * derives from them — the first of the three things the panel owns.
 *
 * Keyed on ASK id, not outreach id, and there is deliberately no pruning
 * effect: an ask's identity survives a regeneration, so a deselection does too,
 * and a stale ask id resolves to no row and drops out of the payload by
 * construction (`excludedOutreachIds`). The pruning this plan carried at round
 * 1 stopped an `unknown_exclusion` crash but silently RE-SELECTED the contact,
 * which could send a message the owner had deselected.
 *
 * `rows` is the SENDABLE rows of the current render, and BOTH derived values
 * are resolved against it rather than against the set alone — that resolution
 * is what keeps a regenerated ask excluded under its new outreach id, so the
 * two must not drift apart onto different lists.
 */
function useExcludedAsks(rows: readonly AskRowView[]): ExcludedAsks {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const toggle = useCallback((askId: string) => {
    setExcluded((current) => toggleExclusion(current, askId));
  }, []);

  const excludedIds = useMemo(
    () => excludedOutreachIds(rows, excluded),
    [rows, excluded],
  );

  return {
    excluded,
    toggle,
    excludedIds,
    sendCount: includedCount(rows, excluded),
  };
}

// ── The write ───────────────────────────────────────────────────────────────

/**
 * Every discriminant any of the four owner routes can answer with, taken from
 * the result unions themselves rather than re-spelled as strings here. That is
 * the whole point of the type: the record below is TOTAL over it, so a new
 * refusal added to `ApproveBatchResult`, `HaltBatchResult`,
 * `RequestAskRegenerationResult` or `WithdrawAskResult` is a tsc error in this
 * file instead of silently degrading to the generic copy.
 */
type LaneStatus =
  | ApproveBatchResult['status']
  | HaltBatchResult['status']
  | RequestAskRegenerationResult['status']
  | WithdrawAskResult['status'];

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
/**
 * The Batch state a `not_regenerable` refusal was taken in, as the wire names
 * it. `built` is excluded because it is the ONE regenerable state, so the
 * server never refuses with it — a widened `isRegenerableBatchState` is then a
 * tsc error here rather than a silently wrong sentence.
 */
type RefusedState = Exclude<SendLaneView['batchState'], 'built'>;

/**
 * What "no longer regenerable" actually MEANS, per state.
 *
 * One sentence for all of them asserted "This batch has been approved" over a
 * halted, expired or closed batch — a stale tab reading a false statement about
 * its own batch, and then being offered a stop for something already stopped.
 * The correcting `state` was already on the wire (`toWire` carries it for
 * exactly this arm) and was being discarded.
 *
 * Total over the union, no `default`: a new Batch state has to state what the
 * owner reads here. "Stop" is the **Halt latch**'s one owner-facing carve-out;
 * `pause`, `resume` and `cancel batch` stay banned, and no arm implies the
 * latch is reversible.
 */
const NOT_REGENERABLE_COPY: Readonly<Record<RefusedState, string>> = {
  veto_window:
    'This batch has been approved, so its messages can no longer be changed. Stop the batch if you need to.',
  approved:
    'This batch has been approved, so its messages can no longer be changed. Stop the batch if you need to.',
  sending:
    'This batch is already going out, so its messages can no longer be changed. Stop the batch if you need to.',
  halted:
    'This batch was stopped, so its messages can no longer be changed. Nothing further will send from it.',
  expired:
    'This batch expired before it was approved, so its messages can no longer be changed. Nothing was sent.',
  closed:
    'This batch is finished, so its messages can no longer be changed.',
  pending:
    'This batch is still being prepared, so there is no message to change yet.',
};

/** For a `state` this build does not know — a server deployed ahead of the
 *  browser — and for the impossible `built`. It claims only what every arm of
 *  the refusal has in common, and sends the owner to the screen that knows. */
const NOT_REGENERABLE_FALLBACK =
  'This batch can no longer be changed. Reload the page to see where it stands.';

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
  // Every arm this build knows names its OWN state (`NOT_REGENERABLE_COPY`
  // below); this entry is the fallback the record's total shape still requires.
  not_regenerable: NOT_REGENERABLE_FALLBACK,
  ask_not_regenerable:
    'We cannot write a new version of this message. Nothing changed.',
  // Reached only if the 429 body ever loses its `message`; the server's own
  // sentence wins when present (`postLaneAction` reads it).
  budget_exhausted:
    'You have reached today\'s limit for new versions of this message. You can ask again tomorrow.',
  // #872 Ask withdrawal. The two 2xx arms have no refusal copy.
  withdrawn: null,
  already_withdrawn: null,
  not_withdrawable:
    'This message can no longer be withdrawn. Reload the page to see where the batch stands.',
  not_live:
    'This message is no longer waiting to send, so it cannot be withdrawn. Reload the page to see where the batch stands.',
};

/** A discriminant this build knows, or null for anything else on the wire — a
 *  server deployed ahead of the browser is a real case, and `in`-checking the
 *  record's OWN keys keeps `toString` and friends off the lookup path. */
function toLaneStatus(value: unknown): LaneStatus | null {
  return typeof value === 'string' && Object.hasOwn(LANE_REFUSAL_COPY, value)
    ? (value as LaneStatus)
    : null;
}

/** The refused state, narrowed against the copy record's OWN keys — same trick
 *  as `toLaneStatus`, and it is what keeps `built` and any state this build has
 *  never heard of out of the lookup. */
function toRefusedState(value: unknown): RefusedState | null {
  return typeof value === 'string' && Object.hasOwn(NOT_REGENERABLE_COPY, value)
    ? (value as RefusedState)
    : null;
}

type LaneOutcome =
  /** The server settled the request: 2xx, carrying its result discriminant
   *  and, for the verbs that report one, its counts. `remainingLive`/`closed`
   *  are read from the body when present and `null` otherwise — approve, halt
   *  and regenerate do not send them. */
  | { kind: 'done'; status: LaneStatus | null; remainingLive: number | null; closed: boolean | null }
  /**
   * The server refused with a reason worth repeating (400 / 409 / 429).
   * `message` is the server's OWN sentence when it wrote one — the 429 body
   * carries no `status`, so without it an exhausted budget would fall through
   * to the generic copy.
   */
  | {
      kind: 'refused';
      status: LaneStatus | null;
      message: string | null;
      /** The Batch state a `not_regenerable` refusal named; null on every
       *  other arm, and on a state this build does not know. */
      state: RefusedState | null;
    }
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
      const result = (await response.json()) as {
        status?: unknown;
        message?: unknown;
        state?: unknown;
        remainingLive?: unknown;
        closed?: unknown;
      };
      const status = toLaneStatus(result.status);
      const message = typeof result.message === 'string' ? result.message : null;
      return response.ok
        ? {
            kind: 'done',
            status,
            remainingLive: typeof result.remainingLive === 'number' ? result.remainingLive : null,
            closed: typeof result.closed === 'boolean' ? result.closed : null,
          }
        : { kind: 'refused', status, message, state: toRefusedState(result.state) };
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
function refusalCopy(
  status: LaneStatus | null,
  message: string | null,
  state: RefusedState | null,
): string {
  if (message !== null) return message;
  // The one refusal whose sentence depends on a second field. Branching here
  // rather than in the record keeps `LANE_REFUSAL_COPY` a flat total map.
  if (status === 'not_regenerable') {
    return state === null ? NOT_REGENERABLE_FALLBACK : NOT_REGENERABLE_COPY[state];
  }
  return (status === null ? null : LANE_REFUSAL_COPY[status]) ?? GENERIC_REFUSAL;
}

/** The sentence the parent announces, from the route's result discriminant
 *  and — for the verbs that report them — the counts the `done` outcome
 *  carries. The one-parameter announces stay assignable unchanged. */
type Announce = (
  status: LaneStatus | null,
  done: { remainingLive: number | null; closed: boolean | null },
) => string;

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

/** The withdraw sentence, from the SERVER's counts — never a client
 *  subtraction over the rows on screen, which cannot see an in-flight row.
 *  "Left to send" is factual for waiting AND in-flight rows and promises
 *  nothing about rows the owner may still stop or withdraw. The idempotent arm
 *  claims nothing new happened; the no-count arm (a server deployed behind
 *  this browser) claims only what it knows. */
const withdrawnAnnounce: Announce = (status, done) => {
  if (status === 'already_withdrawn') return 'This message was already withdrawn.';
  if (done.closed === true) return 'Withdrawn. That was the last one — this batch is finished.';
  if (done.remainingLive === null) return 'Withdrawn.';
  return `Withdrawn. ${countPhrase(done.remainingLive)} left to send.`;
};

/**
 * How a write ended, for the parent. `settled` means the server answered and
 * the sentence describes what it did; `unconfirmed` means the sentence describes
 * only that we do not know — the parent refetches either way, but must not
 * present the second as a report of what happened.
 */
export type LaneWriteOutcome = 'settled' | 'unconfirmed';

/**
 * What the parent must do to the SCREEN after a lane write — the axis that
 * `LaneWriteOutcome` (how certain the answer was) deliberately does not carry.
 *
 * `replace` — the write ended this screen. Approve and stop are TERMINAL: the
 *   panel that comes back is a different screen whatever the server says, so
 *   the refetch may tear this one down and show the loading card meanwhile.
 * `in_place` — the write left the owner mid-task in the SAME panel.
 *   Regeneration is NOT terminal — it returns to the same approvable panel — so
 *   the refetch must not unmount it. Routing it through the terminal path is
 *   what silently reset `excludedAsks` (re-selecting every ask the owner had
 *   deselected) and destroyed `pendingRegen` (making the unchanged-copy report
 *   unreachable in production).
 * `none` — nothing to fetch. The sentence REPORTS on a view the parent has
 *   already handed down; asking for another read would answer a question that
 *   was just answered.
 */
export type LaneRefresh = 'replace' | 'in_place' | 'none';

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
  onChanged: (
    message: string,
    outcome: LaneWriteOutcome,
    refresh: LaneRefresh,
  ) => void;
}

interface LaneWrites {
  /** True while any of the four writes is in flight. */
  busy: boolean;
  /** Copy for the last write the server REFUSED; '' when there is none. */
  error: string;
  approve: () => void;
  halt: () => void;
  regenerate: (askId: string) => void;
  withdraw: (askId: string) => void;
}

/**
 * The lane's four writes and the two pieces of state they own.
 *
 * They settle identically — busy on, error cleared, POST, busy off, then either
 * the parent's announcement or the refusal copy — and differ only in route,
 * body, sentence, and whether the write ENDS this screen, so `perform` is the
 * one settle path. Nothing here refetches: `onChanged` is the parent's cue, and
 * the `LaneRefresh` each verb passes is what tells it which kind of refetch to
 * run. Approve and stop are terminal and say `replace`; regenerate and withdraw
 * are not, and say `in_place` — the panel each returns to is the one the owner
 * is still working in.
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
    async (
      path: string,
      requestBody: Record<string, unknown>,
      announce: Announce,
      refresh: LaneRefresh,
    ) => {
      setBusy(true);
      setError('');
      const outcome = await postLaneAction(path, scope, requestBody);
      setBusy(false);
      if (outcome.kind === 'refused') {
        setError(refusalCopy(outcome.status, outcome.message, outcome.state));
        return;
      }
      // An unconfirmed outcome is handed UP rather than shown here, and the
      // difference is not cosmetic: the batch may be approved with its veto
      // clock already running, so the only honest next screen is the server's
      // own state. The parent refetches, and the panel this error box belongs
      // to is replaced by whatever is actually true.
      if (outcome.kind === 'unconfirmed') {
        onChanged(UNCONFIRMED_OUTCOME, 'unconfirmed', refresh);
        return;
      }
      onChanged(announce(outcome.status, outcome), 'settled', refresh);
    },
    [onChanged, scope],
  );

  const approve = useCallback(() => {
    void perform(
      APPROVE_PATH,
      { batchId, excludedOutreachIds: [...excludedIds] },
      approvedAnnounce(sendCount),
      'replace',
    );
  }, [batchId, excludedIds, perform, sendCount]);

  // The halt body carries ONLY the batch id: the halt reason is derived
  // server-side so the audit trail cannot be told what to say.
  const halt = useCallback(() => {
    void perform(HALT_PATH, { batchId }, haltedAnnounce, 'replace');
  }, [batchId, perform]);

  const regenerate = useCallback(
    (askId: string) => {
      // Same settle path as the other two, but NOT the same screen. The other
      // verbs announce a completed act and end this panel; this one is 202
      // Accepted and comes back to the very panel the owner is working in, so
      // it asks for an `in_place` refetch. The sentence says what was ASKED
      // for; the poll loop reports what happened.
      void perform(REGENERATE_PATH, { batchId, askId }, regenerateAnnounce, 'in_place');
    },
    [batchId, perform],
  );

  const withdraw = useCallback(
    (askId: string) => {
      // `in_place`: the owner is still in the same panel with the rest of the
      // batch; a remount would drop another armed confirmation and flash the
      // loading card. The withdrawn row leaves the list on the refetch because
      // the read model already filters cancelled rows.
      void perform(WITHDRAW_PATH, { batchId, askId }, withdrawnAnnounce, 'in_place');
    },
    [batchId, perform],
  );

  return { busy, error, approve, halt, regenerate, withdraw };
}

// ── The pending regeneration ────────────────────────────────────────────────

interface PendingRegenerationInputs {
  /** The sendable rows this render is showing — the list a settlement is
   *  judged against, and the list the control was offered from. */
  rows: readonly AskRowView[];
  /** The ask the SERVER says is being regenerated right now, or null. */
  regeneratingAskId: string | null;
  /** The lane write. This hook decides what to REMEMBER about a request;
   *  `useLaneWrites` owns how it is sent and how a refusal reads. */
  regenerate: (askId: string) => void;
  onChanged: (
    message: string,
    outcome: LaneWriteOutcome,
    refresh: LaneRefresh,
  ) => void;
}

/**
 * The panel's memory of a regeneration it asked for, and the one outcome the
 * server never announces.
 *
 * A regeneration answers 202 Accepted: the route says the work was TAKEN, and
 * every later fact arrives through the poll loop as a changed view. That leaves
 * exactly one settlement unspoken — the worker refused, completed its outbox
 * row, and left the copy untouched. Nothing on the wire tells that apart from a
 * regeneration still on its way, so the only way to report it is to remember
 * what was asked for and compare it against what came back. Remembering is
 * therefore the whole job here, and it is why an accepted regeneration must
 * refetch `in_place`: a remount throws this marker away and the report becomes
 * unreachable in production.
 */
function usePendingRegeneration({
  rows,
  regeneratingAskId,
  regenerate,
  onChanged,
}: PendingRegenerationInputs): (askId: string) => void {
  /** The ask this panel asked to regenerate, and the attempt number it carried
   *  when we asked. Both halves are needed by the settle effect below: the
   *  first says which row to look at, the second is how a landed regeneration
   *  is told from one that settled without changing anything. */
  const pending = useRef<{ askId: string; attemptNo: number } | null>(null);

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
    const asked = pending.current;
    if (asked === null || regeneratingAskId !== null) return;
    pending.current = null;
    const row = rows.find((candidate) => candidate.askId === asked.askId);
    if (row !== undefined && row.attemptNo === asked.attemptNo) {
      // `none`: this fires ON a refetch that has already landed, so it is a
      // report about the view in hand, not a reason to read again.
      onChanged(
        'We could not write a new version. The message below is unchanged.',
        'settled',
        'none',
      );
    }
  }, [regeneratingAskId, rows, onChanged]);

  return useCallback(
    (askId: string) => {
      const row = rows.find((candidate) => candidate.askId === askId);
      // The control is only ever offered for a row in this list, so an absent
      // row means the list moved underneath the click. Ask anyway — the server
      // decides — but record no pending entry, because there is no attempt
      // number to compare a settlement against.
      pending.current =
        row === undefined ? null : { askId, attemptNo: row.attemptNo };
      regenerate(askId);
    },
    [regenerate, rows],
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

export interface ApprovalPanelProps {
  batchId: string;
  sendLane: SendLaneView;
  attempts: AskAttemptView[];
  /** The location scope the view was read for — the write must name the same
   *  location, or it lands on the owner's default one. */
  scope: string;
  /** Called after every write, with the sentence to announce, whether that
   *  sentence is a report or an admission, and what the parent must do to the
   *  screen — a terminal write may replace it, a regeneration may not. */
  onChanged: (
    message: string,
    outcome: LaneWriteOutcome,
    refresh: LaneRefresh,
  ) => void;
}

export function ApprovalPanel({
  batchId,
  sendLane,
  attempts,
  scope,
  onChanged,
}: ApprovalPanelProps) {
  const rows = useMemo(() => toRows(attempts), [attempts]);
  const sendable = useMemo(
    () => rows.filter((row) => row.deliveryStatus === 'rendered'),
    [rows],
  );
  const live = useMemo(
    () => rows.filter((row) => row.deliveryStatus === 'rendered' || row.deliveryStatus === 'queued'),
    [rows],
  );
  // The armed withdraw confirmation. Held here, not in the list, and CLEARED
  // — not merely hidden — the moment a refetch no longer shows the armed row:
  // an ask that later reappears must need a fresh first tap (plan review
  // round 1, finding 9). Cleared DURING render rather than from an effect —
  // React's "adjust state when a prop changes" pattern (the `ToneChipPicker`
  // precedent): the reset lands in the same commit as the refetch, so no frame
  // ever shows a confirm for a row that is gone, and `react-hooks/set-state-in-
  // effect` rejects the effect form. The guard makes it converge: the re-render
  // it triggers sees `null` and does not write again.
  const [armedAskId, setArmedAskId] = useState<string | null>(null);
  if (armedAskId !== null && !live.some((row) => row.askId === armedAskId)) {
    setArmedAskId(null);
  }

  // Sendability, not readiness: an all-withheld batch is `ready` with nothing
  // to approve, and must not be offered a control that would send 0 messages.
  const mode = panelMode(sendLane, sendable.length);
  const { heading, body } = panelCopy(mode, sendLane);
  const asks = askDisplay(mode);

  const { excluded, toggle, excludedIds, sendCount } = useExcludedAsks(sendable);

  const { busy, error, approve, halt, regenerate, withdraw } = useLaneWrites({
    batchId,
    scope,
    excludedIds,
    sendCount,
    onChanged,
  });

  const onRegenerate = usePendingRegeneration({
    rows: sendable,
    regeneratingAskId: sendLane.regeneratingAskId,
    regenerate,
    onChanged,
  });

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

      {asks === 'selectable' && (
        <SelectableAskList
          rows={sendable}
          excluded={excluded}
          onToggle={toggle}
          disabled={busy}
          regenBudgets={sendLane.regenBudgets}
          regeneratingAskId={sendLane.regeneratingAskId}
          onRegenerate={onRegenerate}
        />
      )}

      {asks === 'withdrawable' && (
        <WithdrawableAskList
          rows={rows}
          pendingAskId={armedAskId}
          onArm={setArmedAskId}
          onWithdraw={(askId) => {
            setArmedAskId(null);
            withdraw(askId);
          }}
          onKeep={() => setArmedAskId(null)}
          disabled={busy}
        />
      )}

      {asks === 'read_only' && <AskList rows={rows} />}

      {asks === 'count' && (
        <p className="rq-approval-summary">{countPhrase(rows.length)} in this batch.</p>
      )}

      <ModerationWithheldNote count={sendLane.moderationWithheld} />

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
