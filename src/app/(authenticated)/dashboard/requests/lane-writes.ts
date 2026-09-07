'use client';

// The Solicitation approval lane's WRITE seam (#886, deferred from the #872
// branch review).
//
// Split out of `ApprovalPanel.tsx` when that file crossed 1,000 lines and the
// thermo-nuclear review made the crossing a presumptive blocker. Only ~94 of
// those lines were #872's; the bulk was this section, already sitting behind a
// `── The write ──` banner that read as a seam. The panel keeps state and
// composition; everything about HOW a lane verb is sent, and how a refusal
// reads, lives here.
//
// THE SEAM IS THE FOUR VERBS AND NOTHING ELSE. `useLaneWrites` owns approve,
// halt, regenerate and withdraw — one settle path, four bodies — plus the two
// pieces of state they own (`busy`, `error`). It never refetches: `onChanged`
// is the parent's cue, and the `LaneRefresh` each verb passes says which kind
// of refetch to run. The panel's other three hooks (`useExcludedAsks`,
// `usePendingRegeneration`, `useArmedWithdrawal`) stay in the panel, because
// they are about what is on SCREEN rather than what is on the wire.
//
// `LaneWriteOutcome` and `LaneRefresh` are exported from HERE rather than from
// the panel, and `RequestsClient` imports them from here: they are the write's
// vocabulary, and the panel is now one of their consumers rather than their
// owner.
//
// `countPhrase` moved with the section for the same one-owner reason. Two of
// the announcements below need it, and so does the panel's prose — keeping it
// in the panel would have made this module import from its own importer.

import { useCallback, useState } from 'react';
import { withSolicitationScope } from '@/app/api/dashboard/solicitation/scope-param';
import type {
  ApproveBatchResult,
  HaltBatchResult,
  RequestAskRegenerationResult,
  WithdrawAskResult,
} from '@/lib/solicitation/approval';
import type { SendLaneView } from '@/lib/solicitation/batch-view';

const APPROVE_PATH = '/api/dashboard/solicitation/batch/approve';
const HALT_PATH = '/api/dashboard/solicitation/batch/halt';
const REGENERATE_PATH = '/api/dashboard/solicitation/batch/regenerate';
const WITHDRAW_PATH = '/api/dashboard/solicitation/batch/withdraw';

export function countPhrase(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
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
    'Some messages are still being prepared. Nothing was approved. Try again in a moment.',
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
   *  are read from the body when present and `null` otherwise. Only
   *  `remainingLive` is withdraw-exclusive; `closed` is sent by approve, halt
   *  AND withdraw (each route's `toWire`), and regenerate sends neither. */
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

const GENERIC_REFUSAL = 'Something went wrong. Nothing changed. Try again.';

/** Deliberately claims nothing about the write. The refetch it triggers is what
 *  answers the question, and both verbs are safe to repeat: approval is CAS'd
 *  on `approved_at IS NULL` and the Halt latch is monotone. */
const UNCONFIRMED_OUTCOME =
  'We could not confirm whether that went through. Reloading the batch now, so check the state below before trying again.';

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
  if (done.closed === true) return 'Withdrawn. That was the last one, so this batch is finished.';
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
export function useLaneWrites({
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
