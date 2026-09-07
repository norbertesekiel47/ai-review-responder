'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AskAttemptView,
  HaltReason,
  SendLaneView,
} from '@/lib/solicitation/batch-view';
import {
  isCancellableDeliveryStatus,
  type WITHDRAWABLE_BATCH_STATES,
} from '@/lib/solicitation/delivery-status';
import { ApprovalActions, type ApprovalVerb } from './ApprovalActions';
import {
  countPhrase,
  useLaneWrites,
  type LaneRefresh,
  type LaneWriteOutcome,
} from './lane-writes';
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
 * A client island owning exactly FOUR things, one hook each: which asks the
 * owner has deselected (`useExcludedAsks`), whether a write is in flight and
 * the resulting error copy (`useLaneWrites`), what this panel last asked to
 * regenerate (`usePendingRegeneration`), and which ask's withdraw control is
 * armed (`useArmedWithdrawal`, #872 — held in the panel and cleared the moment
 * a refetch drops the row). It renders from `sendLane` + `attempts` and never
 * mutates the view it was given; after every settled write it calls
 * `onChanged(message, outcome, refresh)` and the parent refetches, so the fetch
 * loop stays the single owner of what is on screen.
 *
 * THREE of those hooks are file-local; `useLaneWrites` is not, and the split is
 * deliberate (#886). It moved to the sibling `lane-writes.ts` when this file
 * crossed 1,000 lines, taking the whole `── The write ──` section with it —
 * the refusal copy, `postLaneAction`, the four announcements and the settle
 * path. The line falls where it does because the other three hooks are about
 * what is on SCREEN (a selection, a marker, an armed control, all of it lost on
 * remount and none of it the server's business), while the write seam is about
 * what goes on the WIRE. Ownership did not move: this panel is still the only
 * caller, and it still decides which verb runs and what the parent is told.
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
 * owner has already read every message they approved (docs/context/solicitation-send-mode-approval-halt-lane.md "Owner
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
 * Derived from the named owner (`WITHDRAWABLE_BATCH_STATES`, #890) so this
 * mirror can no longer drift from `isWithdrawableState`'s server-side list.
 */
type HaltableState = Extract<
  SendLaneView['batchState'],
  (typeof WITHDRAWABLE_BATCH_STATES)[number]
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
    'RepWorth support stopped this batch. It cannot be resumed. Get in touch if that was not expected.',
  send_window_elapsed:
    'This batch ran out of time before everything went out, so the rest was cancelled. It cannot be resumed.',
  batch_expired:
    'This batch expired before it was approved, so it was stopped. Nothing was sent.',
  // #917. The SAME window ran out as `send_window_elapsed` above — the
  // difference is the cause, and the cause was us. Saying "this batch ran out of
  // time" here is technically true and practically misleading: nothing about
  // this owner's list or timing caused it, and an owner who reads the blander
  // line has no way to learn that. Say what happened, and do not make them ask.
  platform_halt:
    'RepWorth paused review requests across the whole platform while this batch was waiting to send, and its send window ran out during that pause. The rest was cancelled. This was our doing, not anything about your list. Get in touch and we will help you send these again.',
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
        body: 'Read each message below. This is exactly what will be sent, and nothing sends until you approve. You can ask for a new version of any message, but you cannot write one yourself. Deselect anyone you would rather skip.',
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

// ── The veto deadline ───────────────────────────────────────────────────────

/** How often the countdown re-reads the clock. Coarse on purpose: the label
 *  is in whole minutes, so a finer tick would re-render without changing. */
const VETO_TICK_MS = 15_000;
const MINUTE_MS = 60_000;

const VETO_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Postgres `::text` ("2026-07-22 12:15:00+00") or ISO. Returns null for
 * anything unparseable so the caller renders nothing rather than "Invalid
 * Date" — the same rule BatchReport applies to its own timestamps.
 */
export function parseVetoDeadline(value: string): number | null {
  const iso = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The two halves of the deadline line: the absolute time (never changes) and
 * the relative remainder (ticks). Exported for its unit test — the pure rule is
 * the thing worth pinning, not the interval that drives it.
 */
export function vetoDeadlineCopy(
  deadlineMs: number,
  nowMs: number,
): { absolute: string; remaining: string } {
  const absolute = VETO_TIME_FORMAT.format(new Date(deadlineMs));
  const left = deadlineMs - nowMs;
  if (left <= 0) return { absolute, remaining: 'The window has closed. Sending starts now.' };
  if (left < MINUTE_MS) return { absolute, remaining: 'Less than a minute left.' };
  const minutes = Math.ceil(left / MINUTE_MS);
  return { absolute, remaining: `${minutes} min left.` };
}

/**
 * The veto window is the product's undo (docs/context/solicitation-send-mode-approval-halt-lane.md "Owner approval"), so the
 * owner is told exactly when it closes: an absolute time that never moves, and
 * a live remainder in a polite live region (UX audit D5). The clock starts null
 * so the server render carries the absolute time alone and the remainder
 * appears once the browser has a clock — no hydration mismatch, no "NaN min".
 */
function VetoDeadline({ deadlineAt }: { deadlineAt: string }) {
  const deadlineMs = parseVetoDeadline(deadlineAt);
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (deadlineMs === null) return;
    // One interval, cleared on unmount and once the window has closed — the
    // refetch owns what happens next.
    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      if (now >= deadlineMs) clearInterval(interval);
    };
    const first = setTimeout(tick, 0);
    const interval = setInterval(tick, VETO_TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [deadlineMs]);

  if (deadlineMs === null) return null;
  const copy = vetoDeadlineCopy(deadlineMs, nowMs ?? deadlineMs - MINUTE_MS * 2);

  return (
    <p className="rq-veto-deadline">
      <span className="rq-veto-deadline-abs">You can still stop this until {copy.absolute}.</span>{' '}
      <span className="rq-veto-deadline-left" role="status" aria-live="polite">
        {nowMs === null ? '' : copy.remaining}
      </span>
    </p>
  );
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
 * derives from them — the first of the four things the panel owns.
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

// ── The armed withdrawal ────────────────────────────────────────────────────

interface ArmedWithdrawal {
  /** The ONE ask whose withdraw control has taken its first tap, or null. */
  armedAskId: string | null;
  /** First tap: arm this ask (moves the arming if another was armed). */
  arm: (askId: string) => void;
  /** Disarm without posting — the Keep answer, and the confirm's own reset
   *  before it posts. */
  disarm: () => void;
}

/**
 * The armed withdraw confirmation as the panel holds it: which ask's control
 * has taken its first tap, and the two verbs that change it — the fourth of
 * the four things the panel owns (#872).
 *
 * Held here, not in the list, and CLEARED — not merely hidden — the moment a
 * refetch no longer shows the armed row among the LIVE rows: an ask that later
 * reappears must need a fresh first tap (plan review round 1, finding 9).
 * Cleared DURING render rather than from an effect — React's "adjust state
 * when a prop changes" pattern (the `ToneChipPicker` precedent): the reset
 * lands in the same commit as the refetch, so no frame ever shows a confirm
 * for a row that is gone, and `react-hooks/set-state-in-effect` rejects the
 * effect form. The write is GUARDED so it converges: it happens only when a
 * non-null armed id is no longer live — never on every pass — and the
 * re-render it triggers sees `null` and does not write again.
 *
 * `rows` is EVERY row of the current render, because that is the list the
 * withdrawable screen shows; the live subset — `CANCELLABLE_DELIVERY_STATUSES`,
 * the statuses that get a control — is derived here because arming is only
 * ever offered from it, so it is the list a stale arming is judged against.
 */
function useArmedWithdrawal(rows: readonly AskRowView[]): ArmedWithdrawal {
  const live = useMemo(
    () => rows.filter((row) => isCancellableDeliveryStatus(row.deliveryStatus)),
    [rows],
  );
  const [armedAskId, setArmedAskId] = useState<string | null>(null);
  if (armedAskId !== null && !live.some((row) => row.askId === armedAskId)) {
    setArmedAskId(null);
  }

  const disarm = useCallback(() => setArmedAskId(null), []);

  return { armedAskId, arm: setArmedAskId, disarm };
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

  // Sendability, not readiness: an all-withheld batch is `ready` with nothing
  // to approve, and must not be offered a control that would send 0 messages.
  const mode = panelMode(sendLane, sendable.length);
  const { heading, body } = panelCopy(mode, sendLane);
  const asks = askDisplay(mode);

  const { excluded, toggle, excludedIds, sendCount } = useExcludedAsks(sendable);

  const { armedAskId, arm, disarm } = useArmedWithdrawal(rows);

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
      {mode.kind === 'haltable' &&
        mode.state === 'veto_window' &&
        sendLane.vetoDeadlineAt !== null && (
          <VetoDeadline deadlineAt={sendLane.vetoDeadlineAt} />
        )}

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
          armedAskId={armedAskId}
          onArm={arm}
          onWithdraw={(askId) => {
            disarm();
            withdraw(askId);
          }}
          onKeep={disarm}
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
