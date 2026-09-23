import { sql } from '../../../src/lib/db/server';
import { drainPendingDemoViews } from '../../../src/lib/demos/view-tracking';
import { createWorkerLogger, toError, type WorkerLogger } from '../../../src/lib/shared/logger';
import { createGuardedPoll } from '../guarded-poll';

const LOG_PREFIX = '[DemoViewFlushPoller]';

// Five minutes: frequent enough that the admin demos list (`view_count`, read
// by `src/lib/admin/demos-service.ts`) stays close to real-time, far apart
// enough that the whole point of debouncing (#1369 — killing per-view write
// amplification on an unauthenticated page) actually holds under repeat/
// crawler traffic. A code constant, not an env var: this loop has no
// operational reason to be tuned per-deploy, and CLAUDE.md's working rules
// prefer no new env var when a constant will do.
const FLUSH_INTERVAL_MS = 300_000;

// Hard per-cycle deadline (#414). A cycle is a handful of Redis round-trips
// per pending demo (sales-demo volume, never review/response scale) plus one
// batched Postgres UPDATE — a healthy cycle completes in well under a second.
// 60s is generous headroom while staying far under the 5-minute interval, so
// a wedged cycle frees the single-flight flag before the next tick.
const FLUSH_CYCLE_TIMEOUT_MS = 60_000;

/**
 * One flush cycle: drain the Redis-side per-demo view counters
 * (`drainPendingDemoViews`, see `src/lib/demos/view-tracking.ts` for the
 * GETDEL-then-write crash-window trade-off) and apply them to
 * `prospect_demos` as ONE set-based UPDATE via `unnest` — the same pattern
 * `OutboxPoller.markDispatched` and `auto-approval/governor.ts` use for a
 * batch of independent per-id writes, so this is not a new idiom.
 *
 * By the time this function is called, the Redis-side counters are already
 * gone (`drainPendingDemoViews` GETDEL'd them). A thrown/failed UPDATE here
 * therefore loses this cycle's drained increments for the affected demos —
 * the documented, accepted trade (never double-counts; loses at most one
 * flush interval's views on a crash). `prospect_demos` carries no tenant
 * column (deny-all RLS, migration 066), so the UPDATE needs no account/
 * business scoping.
 */
export async function runDemoViewFlush(logger: WorkerLogger): Promise<void> {
  const deltas = await drainPendingDemoViews();
  if (deltas.length === 0) return;

  const ids = deltas.map((d) => d.demoId);
  const counts = deltas.map((d) => d.count);
  // ISO strings, not raw JS Dates: postgres.js cannot infer `timestamptz[]`
  // from an array of Date objects (`cannot cast type timestamp with time
  // zone to timestamp with time zone[]`) — same reason governor.ts's
  // `windowStarts` is pre-serialized before an `unnest(...::timestamptz[])`.
  const lastVieweds = deltas.map((d) => d.lastViewedAt.toISOString());

  try {
    const updated = await sql<{ id: string }[]>`
      UPDATE prospect_demos AS pd
      SET view_count = pd.view_count + flush.delta_count,
          last_viewed_at = flush.last_viewed_at
      FROM unnest(${ids}::uuid[], ${counts}::int[], ${lastVieweds}::timestamptz[])
        AS flush(id, delta_count, last_viewed_at)
      WHERE pd.id = flush.id
      RETURNING pd.id
    `;
    logger.log('Flushed demo view counters', {
      drained_demos: deltas.length,
      updated_rows: updated.length,
    });
  } catch (err) {
    logger.error(
      'Failed to flush demo view counters — drained increments for this cycle are lost',
      { drained_demos: deltas.length },
      toError(err),
    );
  }
}

const guard = createGuardedPoll(runDemoViewFlush, {
  label: LOG_PREFIX,
  intervalMs: FLUSH_INTERVAL_MS,
  timeoutMs: FLUSH_CYCLE_TIMEOUT_MS,
});

export function startDemoViewFlushPoller(): void {
  guard.start(() =>
    createWorkerLogger(LOG_PREFIX).log('Starting', { interval_ms: FLUSH_INTERVAL_MS }),
  );
}

export function stopDemoViewFlushPoller(): void {
  guard.stop();
}
