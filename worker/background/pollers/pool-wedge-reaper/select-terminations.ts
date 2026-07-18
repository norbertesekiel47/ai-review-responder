// The dangerous decision, isolated as a PURE function for property testing:
// given the candidate backends the reaper's SELECT surfaced, decide WHICH to
// terminate and HOW MANY. No side effects, no DB, no clock — every input is a
// parameter — so the runaway-guard cap and the oldest-first ordering are
// exhaustively fast-check-testable without a live pool (#500 T1).
//
// The `pg_terminate_backend` itself lives in reaper-query.ts; this module never
// touches a connection. Keeping the kill-selection here means the SELECT can
// stay a plain query and the poller a plain loop.

/** One wedge candidate row, projected from pg_stat_activity by reaper-query.ts. */
export interface WedgeRow {
  pid: number;
  /** backend_start rendered as text (microsecond-exact; see reaper-query.ts). */
  backendStart: string;
  /** Seconds the backend has been continuously active (now() - state_change). */
  ageS: number;
}

/** A backend selected for termination — the (pid, backend_start) tuple the
 *  revalidating terminate re-checks atomically. */
export interface TerminationTarget {
  pid: number;
  backendStart: string;
}

export interface SelectionResult {
  targets: TerminationTarget[];
  /** Candidates beyond the per-sweep cap — surfaced so the poller can log the
   *  runaway signal instead of silently dropping them. */
  droppedCount: number;
}

/**
 * Choose up to `cap` backends to terminate, oldest-first.
 *
 * Contract:
 *  - Only rows whose age strictly exceeds `ageThresholdS` are candidates
 *    (defense-in-depth: the SELECT already applies the same bound, so this is a
 *    belt-and-braces re-assert on the pure side).
 *  - Candidates are ordered oldest-first (largest `ageS` first) so a cap that
 *    can't take everyone kills the most-wedged backends.
 *  - `targets` is always a subset of the input and never larger than `cap`.
 *  - `droppedCount` is the number of candidates the cap left behind.
 */
export function selectTerminations(
  rows: WedgeRow[],
  opts: { ageThresholdS: number; cap: number },
): SelectionResult {
  const cap = Math.max(0, opts.cap);
  const candidates = rows
    .filter((row) => row.ageS > opts.ageThresholdS)
    .sort((a, b) => b.ageS - a.ageS); // oldest (largest age) first
  const targets = candidates
    .slice(0, cap)
    .map((row) => ({ pid: row.pid, backendStart: row.backendStart }));
  return { targets, droppedCount: Math.max(0, candidates.length - cap) };
}
