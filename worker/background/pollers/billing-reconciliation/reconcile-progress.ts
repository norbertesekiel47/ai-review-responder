// worker/background/pollers/billing-reconciliation/reconcile-progress.ts
//
// Pure cursor/progress helpers for StripeLocationsReconcilePoller — the
// fast-check surface for the rotation state machine. No IO, no module state.
//
// T1 owns nextCursor (keyset advance/reset). T3 adds the cycle classification
// (classifyCycle / evaluateTruncation) that consumes the {queryCompleted,
// total, dispatched} progress snapshot.

/**
 * The keyset resume cursor after a cycle claimed `dispatched` of `accounts`
 * (in id order). Called only when `dispatched > 0`:
 * - partial cycle (`dispatched < accounts.length`) → the last CLAIMED id, so the
 *   deferred tail leads the next cycle;
 * - drained cycle (`dispatched === accounts.length`) → null, wrapping the
 *   rotation to the top next cycle (the accounts query has no LIMIT, so draining
 *   the fetched batch means the rotation is complete).
 */
export function nextCursor(
  dispatched: number,
  accounts: ReadonlyArray<{ id: string }>,
): string | null {
  return dispatched < accounts.length ? accounts[dispatched - 1]!.id : null;
}

/**
 * Mutable per-cycle progress snapshot threaded from `runOnce` into
 * `reconcileCycle`. `reconcileCycle` sets `queryCompleted = true` +
 * `total = accounts.length` the instant the accounts query returns, then bumps
 * `dispatched` on each account it CLAIMS. `runOnce.finally` reads the final
 * snapshot to classify the cycle — even a deadline-aborted cycle leaves behind
 * whatever it managed to set before unwinding.
 */
export interface ReconcileProgress {
  queryCompleted: boolean;
  total: number;
  dispatched: number;
}

export type CycleClassification = 'stalled' | 'truncated' | 'drained';

/**
 * The outcome of one `runOnce` cycle, as seen by `runOnce` itself:
 * - `'ok'` — `reconcileCycle` RETURNED (no throw). A returned cycle always fully
 *   drained: the fan-out only returns when every fetched account was claimed
 *   (a mid-cycle abort is a `withTimeout` rejection, not a normal return).
 * - `'timeout'` — the cycle deadline (`CYCLE_TIMEOUT_MS`) fired; the detached
 *   tail may still be settling. Only here is the progress snapshot consulted.
 * - `'error'` — the cycle threw a NON-timeout error (e.g. the accounts query or
 *   `getStripe()` failed). This is an infrastructure stall, NOT a demand-driven
 *   truncation — it must never be counted toward the sustained-truncation alert.
 */
export type CycleOutcome = 'ok' | 'timeout' | 'error';

/**
 * Classify a cycle from its OUTCOME first, then (only for a deadline timeout)
 * its progress snapshot:
 * - `'ok'` → **drained**: a returned cycle fully drained its batch.
 * - `'error'` → **stalled**: a non-timeout failure is an infra stall, not a
 *   truncation — threading the outcome here is what stops a post-query error
 *   (`queryCompleted && dispatched < total`) from being mis-read as truncated.
 * - `'timeout'` → consult the snapshot:
 *   - `!queryCompleted` → **stalled**: the accounts query never returned (parked
 *     on pool acquisition / query timeout). Nothing fetched → no batch to drain.
 *   - `total === 0` → **drained**: an empty account list is a complete rotation.
 *   - `dispatched < total` → **truncated**: the deadline aborted the sweep before
 *     it drained its fetched batch (dispatched === 0 after a completed query
 *     still counts — a fetched batch left entirely unclaimed).
 *   - `dispatched === total` → **drained**: every fetched account was claimed —
 *     a full drain, even if a late TimeoutError fired on a slow tail.
 */
export function classifyCycle(
  progress: ReconcileProgress,
  outcome: CycleOutcome,
): CycleClassification {
  if (outcome === 'ok') return 'drained';
  if (outcome === 'error') return 'stalled';
  if (!progress.queryCompleted) return 'stalled';
  if (progress.total === 0) return 'drained';
  return progress.dispatched < progress.total ? 'truncated' : 'drained';
}

/**
 * Advance the consecutive-truncation counter for one classified cycle and decide
 * whether THIS cycle crosses into the sustained-truncation alert. The counter
 * means "consecutive deadline-truncated cycles with NOTHING in between", so
 * "consecutive" is literal — anything that is not a truncation breaks the streak:
 * - **drained** → reset to 0, no alert (a full drain breaks a truncation run).
 * - **stalled** → reset to 0, no alert (a stall is not a truncation, so it breaks
 *   the run too — otherwise T,S,T,S,T would page as three consecutive).
 * - **truncated** → increment (clamped at `threshold`); alert exactly when the
 *   increment FIRST reaches `threshold`, so a sustained run pages once — not on
 *   every subsequent truncation.
 */
export function evaluateTruncation(
  consecutive: number,
  cycle: CycleClassification,
  threshold: number,
): { consecutive: number; alert: boolean } {
  if (cycle !== 'truncated') return { consecutive: 0, alert: false };
  const next = Math.min(consecutive + 1, threshold);
  return { consecutive: next, alert: consecutive + 1 === threshold };
}
