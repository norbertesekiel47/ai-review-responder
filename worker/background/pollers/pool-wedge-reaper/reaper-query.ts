// The two server-side statements the reaper runs, isolated from the poller
// loop and the pure kill-selection (select-terminations.ts):
//   1. selectWedgeCandidates — read-only; surfaces backends matching the FULL
//      wedge signature, projecting backend_start as TEXT so the terminate can
//      re-check it microsecond-exact.
//   2. terminateWedges — the SINGLE revalidating terminate. It re-checks the
//      full signature AND the (pid, backend_start) tuples atomically inside one
//      statement, closing the select/kill TOCTOU + PID-reuse race, and is
//      idempotent (a vanished/changed backend simply doesn't join → not killed).
//
// Backend identity is the cooperative query-comment marker, matched anchored to
// the query PREFIX — NOT application_name (Supavisor flattens that to
// 'Supavisor'; see ADR 0007) and NOT a table name. Only RepWorth code injects
// the marker, today on the read-only health-check queries.
import type postgres from 'postgres';

/** Cooperative opt-in identity marker (invariant #500). Anchored-PREFIX matched:
 *  a backend is reapable only when its query BEGINS WITH this exact text. */
export const REAPABLE_MARKER = '/* rw-reapable */';

/** application_name the reaper connects with; a genuinely-direct :5432 route
 *  echoes it back from current_setting, while Supavisor swallows it to
 *  'Supavisor' — the runtime direct-route self-check. */
export const REAPER_APP_NAME = 'rw-wedge-reaper';

/** LIKE pattern for the anchored-prefix marker match. The marker contains no
 *  LIKE wildcards (`%`/`_`), so this is an exact-prefix test. */
const MARKER_PREFIX_PATTERN = `${REAPABLE_MARKER}%`;

/** A backend matching the wedge signature, as the SELECT surfaces it. */
export interface WedgeCandidate {
  pid: number;
  backendStart: string;
  stateChange: string;
  ageS: number;
}

/** Result of one revalidating terminate attempt per still-matching backend. */
export interface TerminationOutcome {
  pid: number;
  terminated: boolean;
}

/**
 * Read-only: surface every client backend in THIS database wedged in the full
 * signature — active + waiting on ClientRead (a socket-level stall) longer than
 * `ageThresholdS`, whose query begins with the cooperative marker.
 *
 * Age keys on `state_change` (continuously-active), not `query_start` (which
 * restamps each cycle). `backend_start` and `state_change` come back as TEXT so
 * the microsecond precision Postgres keeps — but a JS `Date` would truncate to
 * milliseconds — survives the round-trip into the revalidating terminate.
 */
export async function selectWedgeCandidates(
  sql: postgres.Sql,
  ageThresholdS: number,
): Promise<WedgeCandidate[]> {
  const rows = await sql<
    { pid: number; backend_start: string; state_change: string; age_s: number }[]
  >`
    SELECT
      pid,
      backend_start::text AS backend_start,
      state_change::text  AS state_change,
      EXTRACT(EPOCH FROM (now() - state_change))::int AS age_s
    FROM pg_stat_activity
    WHERE backend_type = 'client backend'
      AND datname = current_database()
      AND state = 'active'
      AND wait_event = 'ClientRead'
      AND now() - state_change > make_interval(secs => ${ageThresholdS})
      AND query LIKE ${MARKER_PREFIX_PATTERN}
  `;
  return rows.map((row) => ({
    pid: row.pid,
    backendStart: row.backend_start,
    stateChange: row.state_change,
    ageS: row.age_s,
  }));
}

/**
 * The SINGLE revalidating terminate. Joins pg_stat_activity against the
 * requested (pid, backend_start) tuples and re-checks the FULL wedge signature
 * in the same statement, so a backend that self-healed, was reused for a
 * different query, or aged out between SELECT and terminate simply doesn't join
 * and is never signalled. Returns one row per backend that STILL matched;
 * `terminated=false` (or a shorter/empty result) is tolerated — the target was
 * already gone.
 *
 * The (pid, backend_start) pairs ride as two parallel arrays through `unnest`
 * (`::int[]` + `::timestamptz[]`), which postgres.js parameterizes cleanly —
 * unlike a row-value `IN (...)` list, which its dynamic-value builder does not
 * render correctly (see the T1 deviation note).
 */
export async function terminateWedges(
  sql: postgres.Sql,
  targets: { pid: number; backendStart: string }[],
  ageThresholdS: number,
): Promise<TerminationOutcome[]> {
  if (targets.length === 0) return [];
  const pids = targets.map((t) => t.pid);
  const backendStarts = targets.map((t) => t.backendStart);
  const rows = await sql<{ pid: number; terminated: boolean }[]>`
    SELECT sa.pid, pg_terminate_backend(sa.pid) AS terminated
    FROM pg_stat_activity sa
    JOIN unnest(${pids}::int[], ${backendStarts}::timestamptz[]) AS req(pid, backend_start)
      ON req.pid = sa.pid AND req.backend_start = sa.backend_start
    WHERE sa.datname = current_database()
      AND sa.state = 'active'
      AND sa.wait_event = 'ClientRead'
      AND now() - sa.state_change > make_interval(secs => ${ageThresholdS})
      AND sa.query LIKE ${MARKER_PREFIX_PATTERN}
  `;
  return rows.map((row) => ({ pid: row.pid, terminated: row.terminated }));
}
