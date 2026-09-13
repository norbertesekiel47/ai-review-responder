'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OwnerTurnView } from '@/lib/agents/operator/reads';
import { TURN_STATUS } from '@/lib/agents/operator/schema';
import { getJson } from './useOperatorConversation';

/**
 * Poll cadence (spec §3.2 step 4). 2 s while a reply is plausibly seconds
 * away, 5 s once it clearly is not, and a HARD STOP at 4 minutes.
 *
 * The ceiling exists because of spec §14's Run B open item CA1: five
 * `OutboxPoller` dispatch failures terminalize the `job_outbox` row while the
 * turn is still `accepted`, so that turn never reaches a terminal status and a
 * loop without a deadline spins forever.
 */
const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 5_000;
const POLL_BACKOFF_AFTER_MS = 30_000;
const POLL_DEADLINE_MS = 4 * 60 * 1_000;

const TURNS_PATH = '/api/operator/turns';

/**
 * WHAT THE POLL READS, which is a subset of the reader's own row: the screen
 * asks only whether the turn has finished, and everything it renders comes
 * from the durable transcript instead (RB-07). A `Pick` rather than a
 * re-spelled interface, so a change to the server type lands here (F3).
 */
type TurnView = Pick<
  OwnerTurnView,
  'id' | 'status' | 'failureReason' | 'segments' | 'proposals' | 'unsupported'
>;

export interface TurnPoll {
  timedOut: boolean;
  /** The owner chose to wait: a fresh deadline and a restarted loop. */
  keepWaiting: () => void;
  /** A new turn is a new wait, so an earlier timeout notice must not survive. */
  clearTimedOut: () => void;
}

/**
 * THE POLL LOOP ITSELF, a plain function that OWNS ITS OWN TEARDOWN.
 *
 * It is deliberately not written inline in the effect: a loop that re-arms
 * itself from a `schedule()` helper allocates its next timer somewhere other
 * than the effect body, and an effect's cleanup can only be said to own every
 * allocation when the thing it tears down is the one that made them. So the
 * loop hands back ONE stop function, and the effect's cleanup is that call
 * plus nothing else.
 *
 * THE DEADLINE IS ITS OWN `setTimeout`, armed once when the loop starts, and
 * it is the only thing that can end a stuck poll. Checking the clock at the
 * top of `poll()` is not enough: if `fetch` or `response.json()` never
 * settles, `poll()` never returns, no next tick is ever scheduled, and the
 * screen spins forever with no timer left to notice. The independent timer
 * aborts the controller, which rejects the in-flight request, and shows the
 * recovery actions (RB-02). Both timers are cleared by the returned stopper.
 */
function startTurnPoll(
  turnId: string,
  { onDisabled, onTerminal, onTimedOut }: {
    onDisabled: () => void;
    onTerminal: () => void;
    onTimedOut: () => void;
  },
): () => void {
  const controller = new AbortController();
  const startedAt = Date.now();
  let stopped = false;
  let inFlight = false;
  let tick: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    stopped = true;
    if (tick !== null) clearTimeout(tick);
    tick = null;
  };

  const deadline = setTimeout(() => {
    stop();
    controller.abort();
    onTimedOut();
  }, POLL_DEADLINE_MS);

  const schedule = () => {
    if (stopped) return;
    const elapsed = Date.now() - startedAt;
    tick = setTimeout(
      () => void poll(),
      elapsed > POLL_BACKOFF_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS,
    );
  };

  const poll = async () => {
    if (stopped || inFlight) { if (!stopped) schedule(); return; }
    inFlight = true;
    try {
      const result = await getJson<TurnView>(`${TURNS_PATH}/${turnId}`, controller.signal);
      if (stopped || result.kind === 'aborted') return;
      if (result.kind === 'disabled') { stop(); onDisabled(); return; }
      // A failed read is not a failed turn: the loop keeps its cadence and
      // asks again until the deadline decides otherwise.
      if (result.kind === 'error' || result.kind === 'unreachable') { schedule(); return; }

      if (
        result.value.status === TURN_STATUS.COMPLETED
        || result.value.status === TURN_STATUS.FAILED
      ) {
        stop();
        onTerminal();
        return;
      }
    } finally {
      inFlight = false;
    }
    schedule();
  };

  void poll();
  return () => {
    stop();
    clearTimeout(deadline);
    controller.abort();
  };
}

/**
 * The wait: start the loop, and stop it on unmount or whenever the turn, the
 * halt or the epoch changes.
 *
 * `halted` covers every reason there is nothing to wait for: the surface is
 * gone (`operator_disabled`), or the location the screen is scoped to is not
 * one this account can use (S7).
 */
export function useTurnPoll(
  turnId: string | null,
  { halted, onDisabled, onTerminal }: {
    halted: boolean;
    onDisabled: () => void;
    onTerminal: () => void;
  },
): TurnPoll {
  const [timedOut, setTimedOut] = useState(false);
  /** Bumped to restart the poll loop with a fresh deadline ("Keep waiting"). */
  const [pollEpoch, setPollEpoch] = useState(0);

  useEffect(() => {
    if (turnId === null || halted) return;

    const stop = startTurnPoll(turnId, {
      onDisabled,
      onTerminal,
      onTimedOut: () => { setTimedOut(true); },
    });
    return () => { stop(); };
  }, [turnId, halted, pollEpoch, onDisabled, onTerminal]);

  const clearTimedOut = useCallback(() => { setTimedOut(false); }, []);

  const keepWaiting = useCallback(() => {
    setTimedOut(false);
    setPollEpoch((value) => value + 1);
  }, []);

  return useMemo(
    () => ({ timedOut, keepWaiting, clearTimedOut }),
    [timedOut, keepWaiting, clearTimedOut],
  );
}
