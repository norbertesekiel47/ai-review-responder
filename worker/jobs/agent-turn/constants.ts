/**
 * Owner Operator timing (plan decision L2). Provisional per spec §14 — tune
 * from staging p50/p95 at the checkpoint, not from a hunch.
 */

/**
 * 180 s. Each provider call is bounded at 30 s (LLM_CLIENT_OPTIONS) and
 * runLlmTask may attempt primary then fallback, so two providers × two
 * validation attempts fits with headroom. Above the model timeout by
 * construction, which is what makes a stale claim mean "crashed", not "slow".
 */
export const AGENT_TURN_LEASE_SECONDS = 180;

/**
 * 1200 s (20 min). Above one outbox watchdog window (900 000 ms default), so a
 * predecessor that merely needs re-dispatching gets rescued before this turn
 * gives up on it.
 */
export const AGENT_TURN_PREDECESSOR_STALL_SECONDS = 1200;

/** 10 s between predecessor re-checks. Delay, not retry — see the handler. */
export const AGENT_TURN_PREDECESSOR_WAIT_MS = 10_000;
