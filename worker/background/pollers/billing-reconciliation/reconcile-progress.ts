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
 * Classify a finished (or deadline-aborted) cycle from its progress snapshot:
 * - `!queryCompleted` → **stalled**: the accounts query never returned (parked
 *   on pool acquisition / query timeout). Nothing was fetched, so there was no
 *   batch to drain and no truncation to sustain — the counter is left untouched.
 * - `queryCompleted && total === 0` → **drained**: an empty account list is a
 *   complete rotation (a successful zero-work cycle) → resets the counter.
 * - `queryCompleted && dispatched < total` → **truncated**: the deadline aborted
 *   the sweep before it drained its fetched batch (dispatched === 0 after a
 *   completed query still counts — a fetched batch left entirely unclaimed).
 * - `queryCompleted && dispatched === total` → **drained**: every fetched account
 *   was claimed — a full drain, even if a late TimeoutError fired on a slow tail.
 */
export function classifyCycle(progress: ReconcileProgress): CycleClassification {
  if (!progress.queryCompleted) return 'stalled';
  if (progress.total === 0) return 'drained';
  return progress.dispatched < progress.total ? 'truncated' : 'drained';
}

/**
 * Advance the consecutive-truncation counter for one classified cycle and decide
 * whether THIS cycle crosses into the sustained-truncation alert. Fire-once and
 * clamped:
 * - **drained** → reset to 0, no alert (a full drain breaks any truncation run).
 * - **stalled** → counter untouched, no alert (a stall made no progress; it is
 *   neither a truncation to sustain nor a drain to reset).
 * - **truncated** → increment (clamped at `threshold`); alert exactly when the
 *   increment FIRST reaches `threshold`, so a sustained run pages once — not on
 *   every subsequent truncation.
 */
export function evaluateTruncation(
  consecutive: number,
  cycle: CycleClassification,
  threshold: number,
): { consecutive: number; alert: boolean } {
  if (cycle === 'drained') return { consecutive: 0, alert: false };
  if (cycle === 'stalled') return { consecutive, alert: false };
  const next = Math.min(consecutive + 1, threshold);
  return { consecutive: next, alert: consecutive + 1 === threshold };
}
