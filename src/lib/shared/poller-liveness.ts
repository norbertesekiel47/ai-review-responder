import type { Sql, TransactionSql } from 'postgres';

/**
 * Durable background-loop liveness (#949, migration 118).
 *
 * ## Why this is not `worker/background/poller-heartbeat.ts`
 *
 * That module is an in-process, log-only idle suppressor: it decides whether a
 * poller prints an "Idle heartbeat" line, keeps its clock in a `Map`, and
 * writes NOTHING to the database. Its state dies with the process, so no other
 * component can read it. This module is the durable sibling — a row another
 * component (the Judge health probe, the health-alert poller) can query. The
 * two names are deliberately different so neither is mistaken for the other.
 *
 * ## Why a poller needs a durable heartbeat at all
 *
 * `isJudgeHealthy` inferred Judge health from signals that a dead sweep cannot
 * produce: its staleness arm requires a `job_outbox` row that the sweep itself
 * writes. A sweep that never runs satisfies that predicate vacuously for every
 * response, so the probe answered "healthy" forever while the Judge did no work
 * — and Judge availability is a POSTING precondition on both the Reply lane
 * (invariant #3) and the solicitation release lane (D18). A heartbeat is the
 * only signal that distinguishes "no Judge work to do" from "no Judge".
 *
 * ## Contract
 *
 * `last_cycle_at` means: this loop finished a cycle WITHOUT throwing, at that
 * time. A cycle that throws, or is still running, deliberately leaves the row
 * stale — a cycle that did not complete is not proof of life. A cycle that
 * found nothing to do DOES record one: an idle loop is a working loop.
 *
 * Each poller name has exactly one writer. The constants below are the single
 * authoritative spelling; never pass a bare string literal.
 */

/** `JudgeSweepPoller` — the only writer in this change. */
export const POLLER_JUDGE_SWEEP = 'judge_sweep';

interface LivenessRow {
  last_cycle_at: Date;
  age_seconds: number;
}

/** How long ago a poller last completed a cycle, measured on the DB clock. */
export interface PollerLiveness {
  /** Wall-clock time of the last completed cycle. Reporting only. */
  lastCycleAt: Date;
  /** `NOW() - last_cycle_at`, computed server-side. The value to threshold on. */
  ageSeconds: number;
}

/**
 * Record that `pollerName` completed a cycle now. Call as the LAST statement of
 * the cycle, after every unit of work has succeeded.
 *
 * A plain upsert, not a `job_outbox` row: it starts no follow-up work, so the
 * transactional-outbox invariant (#2) does not apply. Errors propagate — a
 * heartbeat that silently failed to write is worse than a loud one, because the
 * probe would then fail closed for a reason nobody logged.
 */
export async function recordPollerCycle(
  sql: Sql | TransactionSql,
  pollerName: string,
): Promise<void> {
  await sql`
    INSERT INTO poller_heartbeats (poller_name, last_cycle_at)
    VALUES (${pollerName}, NOW())
    ON CONFLICT (poller_name) DO UPDATE SET last_cycle_at = NOW()
  `;
}

/**
 * When `pollerName` last completed a cycle, or `null` when it never has.
 *
 * `null` is a REAL answer, not an error: it is what a freshly migrated database
 * returns, and what a loop that has never once run returns. Callers decide what
 * it means — every caller today treats it as "not alive" (fail closed).
 *
 * **The age is computed on the DATABASE clock, never in JavaScript.** Two
 * reasons, both load-bearing:
 *
 * 1. The worker's clock and Postgres' clock are different clocks. Every other
 *    health signal in this codebase thresholds against `NOW()`, and a probe
 *    that mixed the two would drift with host clock skew rather than with
 *    anything about the system it measures.
 * 2. postgres.js decodes `timestamptz` into a JS `Date`, silently truncating
 *    microseconds. Returning the age as an integer sidesteps that boundary
 *    entirely instead of relying on the truncation being harmless.
 *
 * `lastCycleAt` is still returned because an alert has to SAY when the loop
 * was last seen, not merely that it is late.
 */
export async function readPollerLiveness(
  sql: Sql | TransactionSql,
  pollerName: string,
): Promise<PollerLiveness | null> {
  const [row] = await sql<LivenessRow[]>`
    SELECT
      last_cycle_at,
      EXTRACT(EPOCH FROM (NOW() - last_cycle_at))::int AS age_seconds
    FROM poller_heartbeats
    WHERE poller_name = ${pollerName}
  `;
  if (!row) return null;
  return { lastCycleAt: row.last_cycle_at, ageSeconds: row.age_seconds };
}
