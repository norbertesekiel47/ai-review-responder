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
// BOTH operations below run as a single Lua EVAL, not a MULTI/EXEC pipeline.
// This is a deliberate choice, not a style preference: a MULTI/EXEC's
// transactional guarantee depends on the provider genuinely honoring
// connection-scoped transaction state, which this codebase has never
// verified against the Upstash cache instance (no prior `.multi()` call
// exists anywhere against `getCacheRedis()`). `EVAL` carries no such
// uncertainty — the whole script executes as ONE atomic server-side
// operation under the standard Redis scripting contract, and this codebase
// already relies on exactly that against this same Upstash instance in
// production (`RATE_LIMIT_LUA` in `src/lib/shared/rate-limit.ts`,
// `RELEASE_LOCK_LUA` in `redis-cache.ts` above). Both EVAL calls below
// inherit the shared client's `commandTimeout: 3_000` / `connectTimeout:
// 3_000` (`getCacheRedisOptions`, this file's sibling) like every other
// command on this client, so a stalled Upstash cannot hang either the public
// page or a flush cycle indefinitely — it fails within ~3s into the existing
// fail-open/catch paths below.
//
// Crash-window trade-off (#1369's design constraint): once
// `drainPendingDemoViews`'s claim script has GETDEL'd a demo's counter, that
// count exists ONLY in the poller's in-memory batch until the Postgres
// UPDATE commits. A poller crash or DB failure in that window loses at most
// one flush interval's worth of views for the affected demos — never
// negative, never duplicated, because the claim is atomic and the counter
// key is gone the instant it is read. Losing a handful of view-count
// increments on an admin-facing, non-billing metric is an accepted trade;
// double-counting (an UPDATE applied twice for the same increment) is the
// outcome this design rules out structurally.

const PENDING_SET_KEY = 'demo_view:pending';

function countKey(demoId: string): string {
  return `demo_view:count:${demoId}`;
}

function lastViewedKey(demoId: string): string {
  return `demo_view:last_viewed:${demoId}`;
}

// KEYS[1] counter, KEYS[2] last-viewed, KEYS[3] pending set.
// ARGV[1] now (epoch ms, string), ARGV[2] demoId.
const RECORD_VIEW_LUA = `
redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[2])
return 1
`;

// KEYS[1] counter, KEYS[2] last-viewed, KEYS[3] pending set. ARGV[1] demoId.
// GETDEL both value keys (never leaves a permanent last-viewed key behind —
// it is recreated by the next `recordDemoView`, so no TTL is needed either)
// then SREM the pending-set membership, all inside the one script.
const CLAIM_DEMO_VIEW_LUA = `
local count = redis.call('GETDEL', KEYS[1])
local lastViewed = redis.call('GETDEL', KEYS[2])
redis.call('SREM', KEYS[3], ARGV[1])
return {count, lastViewed}
`;

/**
 * Fail-open, best-effort view bump. Never throws — a Redis outage must not
 * break the public demo page (only the debounced counter is lost; the page
 * itself never depended on the old synchronous Postgres write for anything
 * user-visible). The counter INCR, last-viewed SET and pending-set SADD run
 * as one atomic Lua script, so nothing ever observes a partial write — in
 * particular, a counter can never exist without its id also being tracked in
 * the pending set the flush poller reads.
 */
export async function recordDemoView(demoId: string): Promise<void> {
  try {
    const redis = getCacheRedis();
    await redis.eval(
      RECORD_VIEW_LUA,
      3,
      countKey(demoId),
      lastViewedKey(demoId),
      PENDING_SET_KEY,
      Date.now().toString(),
      demoId,
    );
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
 * Drains every demo currently in the pending set: one atomic Lua script per
 * demo GETDELs its counter AND its last-viewed timestamp, then SREMs it from
 * the pending set — all three as a single Redis command, so no other client
 * command (in particular, a concurrent `recordDemoView` for the SAME demo)
 * can ever land in the middle of the claim. A racing view either completes
 * entirely BEFORE this script runs (its increment is included in this
 * cycle's count) or entirely AFTER (its SADD re-adds the id — the claim's
 * SREM has already run by then — so a LATER drain picks it up). There is no
 * window in which a view can be counted but never tracked for a future
 * drain: that was the bug in an earlier (GETDEL, then GET, then SREM as
 * three separate round-trips) version of this function, which really could
 * lose a concurrent view's count permanently rather than merely on a delay,
 * because a racing SADD landing between the separate GETDEL and SREM calls
 * got silently undone by the SREM with no guarantee of ever being retried.
 *
 * A demo whose counter GETDEL returns null/zero (raced empty by a concurrent
 * drain, or a stale pending-set member) is dropped with no Postgres write.
 *
 * Redis errors are caught PER DEMO so one bad key cannot blank the whole
 * cycle; the affected demo is skipped this cycle and retried on the next
 * drain (its pending-set membership, if any, is left untouched — the whole
 * point of one atomic script is that a failed call has made NO partial
 * change).
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
      const [countRaw, lastViewedRaw] = (await redis.eval(
        CLAIM_DEMO_VIEW_LUA,
        3,
        countKey(demoId),
        lastViewedKey(demoId),
        PENDING_SET_KEY,
        demoId,
      )) as [string | null, string | null];
      const count = countRaw ? parseInt(countRaw, 10) : 0;
      if (!Number.isFinite(count) || count <= 0) continue;
      const lastViewedAt = lastViewedRaw ? new Date(parseInt(lastViewedRaw, 10)) : new Date();
      deltas.push({ demoId, count, lastViewedAt });
    } catch (err) {
      reportCaughtError('demo-view-tracking', err, { phase: 'drain_demo', demo_id: demoId });
    }
  }
  return deltas;
}
