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
