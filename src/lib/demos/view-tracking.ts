import { getCacheRedis } from '@/lib/db/redis-cache';
import { reportCaughtError } from '@/lib/shared/report-caught-error';

// Redis-only demo view-count tracking (#1369). The public demo viewer
// (`src/app/(public)/demo/[slug]/page.tsx`) used to fire an un-awaited
// `UPDATE prospect_demos SET view_count = view_count + 1 ...` on every
// completed-demo render — an unauthenticated page, so crawler/bot traffic
// wrote to Postgres on every hit. `recordDemoView` replaces that write with a
// Redis INCR on the CACHE instance (Upstash — the Vercel-reachable one; NOT
// the BullMQ queue Redis, see `src/lib/db/redis-cache.ts`).
// `DemoViewFlushPoller` (Railway) periodically drains the counters into one
// batched Postgres UPDATE.
//
// Crash-window trade-off (#1369's design constraint): once
// `drainPendingDemoViews` has GETDEL'd a demo's counter, that count exists
// ONLY in the poller's in-memory batch until the Postgres UPDATE commits. A
// poller crash or DB failure in that window loses at most one flush
// interval's worth of views for the affected demos — never negative, never
// duplicated, because GETDEL is atomic and the counter key is gone the
// instant it is read. Losing a handful of view-count increments on an
// admin-facing, non-billing metric is an accepted trade; double-counting (an
// UPDATE applied twice for the same increment) is the outcome this design
// rules out structurally.

const PENDING_SET_KEY = 'demo_view:pending';

function countKey(demoId: string): string {
  return `demo_view:count:${demoId}`;
}

function lastViewedKey(demoId: string): string {
  return `demo_view:last_viewed:${demoId}`;
}

/**
 * Fail-open, best-effort view bump. Never throws — a Redis outage must not
 * break the public demo page (only the debounced counter is lost; the page
 * itself never depended on the old synchronous Postgres write for anything
 * user-visible). The three writes — counter INCR, last-viewed SET, pending-
 * set SADD — run as one MULTI/EXEC so a mid-batch connection drop leaves NONE
 * of them applied, never a counter key orphaned outside the pending set the
 * flush poller uses to find it.
 */
export async function recordDemoView(demoId: string): Promise<void> {
  try {
    const redis = getCacheRedis();
    await redis
      .multi()
      .incr(countKey(demoId))
      .set(lastViewedKey(demoId), Date.now().toString())
      .sadd(PENDING_SET_KEY, demoId)
      .exec();
  } catch (err) {
    reportCaughtError('demo-view-tracking', err, { demo_id: demoId, phase: 'record' });
  }
}

export interface DemoViewDelta {
  demoId: string;
  count: number;
  lastViewedAt: Date;
}

/**
 * Drains every demo currently in the pending set: GETDEL its counter (atomic
 * read-and-clear — a view landing AFTER this line starts a FRESH counter
 * rather than being folded into a count this cycle has already claimed),
 * reads its last-viewed timestamp, then removes it from the pending set.
 *
 * A demo whose counter GETDEL returns null/zero (raced empty by a concurrent
 * drain, or a stale pending-set member) is dropped with no Postgres write. A
 * view that lands between this GETDEL and the SREM below re-adds the id via
 * its own SADD — idempotent whether or not we have removed it yet — so in
 * the rare case our SREM wins that race, the increment is simply picked up
 * on a LATER cycle instead of this one: a bounded, self-healing delay, never
 * a silent loss.
 *
 * Redis errors are caught PER DEMO so one bad key cannot blank the whole
 * cycle; the affected demo is skipped this cycle and retried on the next
 * drain (its pending-set membership, if any, is left untouched).
 */
export async function drainPendingDemoViews(): Promise<DemoViewDelta[]> {
  const redis = getCacheRedis();

  let pendingIds: string[];
  try {
    pendingIds = await redis.smembers(PENDING_SET_KEY);
  } catch (err) {
    reportCaughtError('demo-view-tracking', err, { phase: 'read_pending_set' });
    return [];
  }
  if (pendingIds.length === 0) return [];

  const deltas: DemoViewDelta[] = [];
  for (const demoId of pendingIds) {
    try {
      const countRaw = await redis.getdel(countKey(demoId));
      const count = countRaw ? parseInt(countRaw, 10) : 0;
      if (!Number.isFinite(count) || count <= 0) {
        await redis.srem(PENDING_SET_KEY, demoId);
        continue;
      }
      const lastViewedRaw = await redis.get(lastViewedKey(demoId));
      const lastViewedAt = lastViewedRaw ? new Date(parseInt(lastViewedRaw, 10)) : new Date();
      // Immediately after the GETDEL claims the count, to keep the re-add
      // race window described above as small as possible.
      await redis.srem(PENDING_SET_KEY, demoId);
      deltas.push({ demoId, count, lastViewedAt });
    } catch (err) {
      reportCaughtError('demo-view-tracking', err, { phase: 'drain_demo', demo_id: demoId });
    }
  }
  return deltas;
}
