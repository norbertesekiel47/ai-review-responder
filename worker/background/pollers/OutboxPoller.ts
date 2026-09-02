import * as Sentry from '@sentry/node';
import type { Queue } from 'bullmq';
import type { Sql } from 'postgres';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import {
  createWorkerLogger,
  logUnhandledPollError,
  toError,
  type WorkerLogger,
} from '../../../src/lib/shared/logger';
import { withTimeout } from '../../../src/lib/shared/with-timeout';
import { topicToQueue } from '../../queues';

const LOG_PREFIX = '[OutboxPoller]';

interface OutboxEntry {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

// Read at runtime (NOT module top level — convention #4: never call
// getWorkerConfig() at import). Worker env is immutable after boot, so a runtime
// read returns the same value a once-at-import const did. Parse/default preserved.
function readPollIntervalMs(): number {
  // 5s default: the claim query is a cheap indexed FOR UPDATE SKIP LOCKED
  // scan, so polling 6× more often is negligible DB load — but it cuts the
  // median per-hop outbox wait from ~15s to ~2.5s across the four
  // webhook→ingest→generate→notify hops.
  return parseInt(getWorkerConfig().OUTBOX_POLL_INTERVAL_MS || '5000', 10);
}

function readBatchSize(): number {
  const raw = parseInt(getWorkerConfig().OUTBOX_BATCH_SIZE || '50', 10);
  if (!Number.isFinite(raw) || raw < 1) return 50;
  if (raw > 500) return 500;
  return raw;
}

// A BullMQ enqueue can park forever in ioredis' offline command queue because
// the queue connection uses `maxRetriesPerRequest: null` (required by BullMQ).
// An unbounded `queue.add` is what wedged the poller in prod: the cycle never
// returned, so `isPolling` stayed true and every later tick no-op'd at the
// guard. Bound each dispatch so a stuck Redis surfaces as a per-row failure
// (re-pended/dead-lettered via the existing dispatch catch) instead of a
// silent permanent stall.
function readDispatchTimeoutMs(): number {
  const raw = parseInt(getWorkerConfig().OUTBOX_DISPATCH_TIMEOUT_MS || '10000', 10);
  if (!Number.isFinite(raw) || raw < 1000) return 10000;
  return raw;
}

// Watchdog rescue window for rows stuck in 'dispatched' (worker crashed after
// dispatch, before completion). BullMQ's own retry budget spans only ~1-2
// minutes (attempts × exponential backoff), so this window is the real
// recovery bound after an outage that outlasts the in-band retries: a
// provider blip longer than the BullMQ budget stalls affected rows until the
// watchdog re-pends them. 15 minutes keeps that stall tolerable while staying
// far above any legitimate job runtime except the initial Zernio backfill —
// which is idempotent by design (processReview dedupes), so a rare re-dispatch
// of a >15-min backfill is wasteful, not harmful.
function readWatchdogStaleMs(): number {
  const raw = parseInt(getWorkerConfig().OUTBOX_WATCHDOG_STALE_MS || '', 10);
  if (Number.isFinite(raw) && raw >= 60_000) return raw;
  return 900_000;
}

// Defense in depth for the same failure class: even if some *other* await in a
// cycle hangs without a timeout of its own, a single wedged cycle must never
// silence the poller forever. The overlap guard is therefore time-bounded — a
// cycle in flight longer than this is assumed wedged, logged at error, and a
// fresh cycle is allowed to supersede it. Concurrent cycles are already safe
// (claims use FOR UPDATE SKIP LOCKED; every dispatch UPDATE is attempt-scoped),
// so proceeding can only help. Default 4× the poll interval (min 60s).
function readMaxCycleMs(): number {
  const raw = parseInt(getWorkerConfig().OUTBOX_POLL_MAX_CYCLE_MS || '', 10);
  if (Number.isFinite(raw) && raw >= 1000) return raw;
  return Math.max(readPollIntervalMs() * 4, 60_000);
}

let pollerInterval: ReturnType<typeof setInterval> | null = null;
// Generation token + start timestamp for the time-bounded overlap guard. A
// monotonically increasing token lets a wedged predecessor's late `finally`
// avoid clearing a newer cycle's guard.
let activeCycleToken: number | null = null;
let activeCycleStartedAt = 0;
let cycleSeq = 0;

/**
 * Watchdog recovery for rows stuck in 'dispatched'/'dispatching' — a BullMQ
 * worker crashed after the poller marked the entry dispatched but before the
 * worker completed it. Resets retryable rows to 'pending'; terminalizes rows
 * out of attempts. Extracted from pollOutbox at #736 with `db` explicit
 * (mirrors `runOnboardingDripCycle(db, asOf)`) so the live-DB suite can drive
 * exactly this phase with its own client, without the claim/dispatch phases
 * touching Redis or contaminating rows.
 */
export async function runOutboxWatchdogRecovery(
  db: Sql,
  watchdogStaleSecs: number,
  logger: WorkerLogger,
): Promise<void> {
  await db.begin(async (tx) => {
    const [recovered] = await tx<{ count: string }[]>`
      WITH recovered AS (
        UPDATE job_outbox
        SET status = 'pending', available_at = NOW(), dispatched_at = NULL
        WHERE status = 'dispatched'
          AND dispatched_at < NOW() - make_interval(secs => ${watchdogStaleSecs})
          AND attempts < max_attempts
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM recovered
    `;

    // last_error is preserved when a per-job error is already present (#736):
    // failed-hooks record bounded error classes on still-dispatched rows
    // (recordOutboxTransientError — e.g. generate-asks retryable exhaustion),
    // and overwriting them with the generic reclaim text is what made #719's
    // 93 failed rows read as routine watchdog reclaims for three months. The
    // generic text is a fallback for rows that genuinely died without
    // recording anything. This writes nothing new itself, so the
    // bounded-class-only PII contract (worker/jobs/csv-ingest/failed-hook.ts)
    // is honored by construction.
    const [terminated] = await tx<{ count: string }[]>`
      WITH terminated AS (
        UPDATE job_outbox
        SET status = 'failed',
            last_error = COALESCE(NULLIF(last_error, ''), 'Stale dispatched entry exceeded max_attempts'),
            completed_at = NOW()
        WHERE status = 'dispatched'
          AND dispatched_at < NOW() - make_interval(secs => ${watchdogStaleSecs})
          AND attempts >= max_attempts
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM terminated
    `;

    const recoveredCount = parseInt(recovered?.count ?? '0', 10);
    const terminatedCount = parseInt(terminated?.count ?? '0', 10);

    // Recover stale 'dispatching' rows (claimed but process crashed before dispatch).
    // Only recover rows older than 2 minutes — active claims from other processes
    // use dispatching + dispatched_at = NOW() and should not be reset.
    const [staleDispatching] = await tx<{ count: string }[]>`
      WITH recovered_dispatching AS (
        UPDATE job_outbox
        SET status = 'pending', available_at = NOW(), dispatched_at = NULL
        WHERE status = 'dispatching'
          AND attempts < max_attempts
          AND (dispatched_at IS NULL OR dispatched_at < NOW() - INTERVAL '2 minutes')
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM recovered_dispatching
    `;

    const staleDispatchingCount = parseInt(staleDispatching?.count ?? '0', 10);

    if (recoveredCount > 0 || terminatedCount > 0 || staleDispatchingCount > 0) {
      logger.log('Watchdog recovered stale entries', {
        recovered: recoveredCount,
        failed: terminatedCount,
        stale_dispatching: staleDispatchingCount,
      });
    }
  });
}

// Drain budget: after a FULL batch the cycle re-claims immediately instead of
// waiting for the next tick, until a batch comes back short or this budget is
// spent. Pre-bulk the poller moved at most one batch per tick (~10 rows/s);
// the budget is what lets a burst drain at the rate Postgres and Redis allow
// while still yielding to the tick cadence. Kept strictly below the overlap
// guard's wedge threshold (readMaxCycleMs) so a long legitimate drain can never
// be mistaken for a wedged cycle. `0` disables the loop (one batch per tick).
function readDrainBudgetMs(): number {
  const ceiling = Math.floor(readMaxCycleMs() / 2);
  const raw = parseInt(getWorkerConfig().OUTBOX_DRAIN_BUDGET_MS || '', 10);
  const value = Number.isFinite(raw) && raw >= 0 ? raw : 4000;
  return Math.min(value, ceiling);
}

interface PreparedJob {
  entry: OutboxEntry;
  job: { name: string; data: Record<string, unknown>; opts: { jobId: string } };
}

async function claimPendingBatch(batchSize: number): Promise<OutboxEntry[]> {
  return sql<OutboxEntry[]>`
    UPDATE job_outbox
    SET status = 'dispatching', attempts = attempts + 1, dispatched_at = NOW()
    WHERE id IN (
      SELECT id FROM job_outbox
      WHERE status = 'pending'
        AND available_at <= NOW()
      ORDER BY available_at
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, topic, payload, attempts, max_attempts
  `;
}

/**
 * Attempt-scoped bulk status write for a set of claimed rows. Pairs each id
 * with the attempt number the claim returned, so a stale cycle whose rows were
 * since re-claimed (attempts bumped) by a newer cycle writes nothing — the same
 * optimistic-lock guard the per-row UPDATEs carried before bulk dispatch.
 */
async function markDispatched(entries: OutboxEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const ids = entries.map((e) => e.id);
  const attempts = entries.map((e) => e.attempts);
  await sql`
    UPDATE job_outbox AS o
    SET status = 'dispatched', dispatched_at = NOW()
    FROM unnest(${ids}::uuid[], ${attempts}::int[]) AS claimed(id, attempts)
    WHERE o.id = claimed.id
      AND o.status = 'dispatching'
      AND o.attempts = claimed.attempts
  `;
}

async function markDispatchFailed(
  entries: OutboxEntry[],
  errorMsg: string,
  logger: WorkerLogger,
): Promise<void> {
  const exhausted = entries.filter((e) => e.attempts >= e.max_attempts);
  const retryable = entries.filter((e) => e.attempts < e.max_attempts);

  if (exhausted.length > 0) {
    logger.error('Entries exceeded max_attempts, marking as failed', {
      outbox_ids: exhausted.map((e) => e.id),
      count: exhausted.length,
    });
    await sql`
      UPDATE job_outbox AS o
      SET status = 'failed', last_error = ${errorMsg}
      FROM unnest(${exhausted.map((e) => e.id)}::uuid[], ${exhausted.map((e) => e.attempts)}::int[]) AS claimed(id, attempts)
      WHERE o.id = claimed.id
        AND o.status = 'dispatching'
        AND o.attempts = claimed.attempts
    `;
  }

  if (retryable.length > 0) {
    // Reset to pending for a later cycle; the claim bumps attempts again, so
    // the retry carries a fresh jobId.
    await sql`
      UPDATE job_outbox AS o
      SET status = 'pending', last_error = ${errorMsg}
      FROM unnest(${retryable.map((e) => e.id)}::uuid[], ${retryable.map((e) => e.attempts)}::int[]) AS claimed(id, attempts)
      WHERE o.id = claimed.id
        AND o.status = 'dispatching'
        AND o.attempts = claimed.attempts
    `;
  }
}

async function failUnknownTopic(entry: OutboxEntry, logger: WorkerLogger): Promise<void> {
  logger.error('Unknown topic for outbox entry', { topic: entry.topic, outbox_id: entry.id });
  // Unknown topic means a registration drift between the outbox producer and
  // the queue registry — an operational bug that would otherwise silently turn
  // rows into 'failed' without operator visibility. Capture distinctly (not
  // just a breadcrumb) so it surfaces in the Sentry issues feed rather than
  // only as attached context on the next unrelated exception.
  Sentry.captureMessage(
    `[OutboxPoller] Unknown topic "${entry.topic}" — queue registration drift`,
    {
      level: 'error',
      tags: { subsystem: 'outbox', topic: entry.topic },
      extra: { outbox_id: entry.id, attempts: entry.attempts },
    },
  );
  await sql`
    UPDATE job_outbox
    SET status = 'failed',
        last_error = ${'Unknown topic: ' + entry.topic}
    WHERE id = ${entry.id}
      AND status = 'dispatching'
      AND attempts = ${entry.attempts}
  `;
}

function prepareJob(entry: OutboxEntry): PreparedJob {
  // Postgres.js may return JSONB as a string depending on connection config.
  // Ensure it's a parsed object before passing to BullMQ.
  const payload = typeof entry.payload === 'string'
    ? JSON.parse(entry.payload) as Record<string, unknown>
    : entry.payload;

  // jobId includes attempt count so watchdog-recovered entries get a fresh
  // BullMQ job. Without this, BullMQ treats the re-add as a duplicate of the
  // old completed/failed job and silently drops it. outbox_id is passed in
  // payload so workers can complete the right outbox entry regardless of the
  // BullMQ jobId format. entry.attempts is already incremented by the claim.
  const jobId = `${entry.id}_${entry.attempts}`;
  return {
    entry,
    job: {
      name: entry.topic,
      data: { ...payload, outbox_id: entry.id, outbox_attempt: entry.attempts },
      opts: { jobId },
    },
  };
}

/**
 * One BullMQ round trip per topic group instead of one per row.
 *
 * Failure is handled per GROUP, all-or-nothing: `addBulk` pipelines the adds,
 * so on rejection or timeout some jobs may already be in Redis. Every row in
 * the group is re-pended (or dead-lettered once out of attempts), exactly as
 * a single row was before; a re-claim bumps `attempts`, so the retry carries a
 * new jobId and any job that did land runs alongside it. That is the same
 * duplicate the per-row timeout path already produced, and every worker is
 * idempotent on `outbox_id` by invariant — so the widened blast radius costs
 * duplicate work, never lost or double-applied work. The alternative (falling
 * back to per-row `queue.add` after a bulk failure) would re-introduce N×
 * dispatch timeouts per group against a dead Redis, the stall bulk removes.
 */
/** Resolves `true` when any row in the group hit the dispatch-failure path. */
// fallow-ignore-next-line complexity
async function dispatchTopicGroup(
  topic: string,
  queue: Queue,
  entries: OutboxEntry[],
  dispatchTimeoutMs: number,
  logger: WorkerLogger,
): Promise<boolean> {
  let failed = false;
  const prepared: PreparedJob[] = [];
  for (const entry of entries) {
    try {
      prepared.push(prepareJob(entry));
    } catch (prepareError) {
      // A malformed payload is a per-row defect, not a transport failure; it
      // must not take the rest of the group down with it.
      logger.error(
        'Failed to prepare entry for dispatch',
        { outbox_id: entry.id, topic },
        toError(prepareError),
      );
      await markDispatchFailed([entry], toError(prepareError).message, logger);
      failed = true;
    }
  }
  if (prepared.length === 0) return failed;

  const groupEntries = prepared.map((p) => p.entry);
  try {
    await withTimeout(
      queue.addBulk(prepared.map((p) => p.job)),
      dispatchTimeoutMs,
      `outbox dispatch ${topic} ×${prepared.length}`,
    );

    Sentry.addBreadcrumb({
      category: 'outbox',
      message: `Dispatched ${topic} ×${prepared.length}`,
      level: 'info',
    });

    await markDispatched(groupEntries);
  } catch (dispatchError) {
    logger.error(
      'Failed to dispatch topic group',
      { topic, count: groupEntries.length, outbox_ids: groupEntries.map((e) => e.id) },
      toError(dispatchError),
    );

    Sentry.addBreadcrumb({
      category: 'outbox',
      message: `Dispatch failed ${topic} ×${groupEntries.length}`,
      level: 'error',
    });

    const errorMsg = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
    await markDispatchFailed(groupEntries, errorMsg, logger);
    failed = true;
  }
  return failed;
}

/** Resolves `true` when any topic group hit the dispatch-failure path. */
async function dispatchBatch(
  entries: OutboxEntry[],
  dispatchTimeoutMs: number,
  logger: WorkerLogger,
): Promise<boolean> {
  let anyGroupFailed = false;
  const groups = new Map<string, { queue: Queue; entries: OutboxEntry[] }>();
  for (const entry of entries) {
    const queue = topicToQueue[entry.topic];
    if (!queue) {
      await failUnknownTopic(entry, logger);
      continue;
    }
    const group = groups.get(entry.topic);
    if (group) group.entries.push(entry);
    else groups.set(entry.topic, { queue, entries: [entry] });
  }

  // Groups dispatch serially: the ceiling this removes was per-ROW round
  // trips, not per-group, and serial groups keep Redis and pool pressure
  // identical to the pre-bulk poller.
  for (const [topic, group] of groups) {
    const groupFailed = await dispatchTopicGroup(
      topic,
      group.queue,
      group.entries,
      dispatchTimeoutMs,
      logger,
    );
    anyGroupFailed = anyGroupFailed || groupFailed;
  }
  return anyGroupFailed;
}

// Watchdog, then claim + bulk-dispatch, repeated within the drain budget.
export async function pollOutbox(): Promise<void> {
  const logger = createWorkerLogger(LOG_PREFIX);
  const maxCycleMs = readMaxCycleMs();

  // Time-bounded overlap guard with self-recovery. A normal in-flight cycle
  // makes a fresh tick a no-op; a cycle that has overrun maxCycleMs is
  // assumed wedged, logged, and superseded so the poller can never die silently.
  if (activeCycleToken !== null) {
    const elapsed = Date.now() - activeCycleStartedAt;
    if (elapsed < maxCycleMs) return;
    logger.error(
      'Previous poll cycle exceeded max duration; assuming wedged and starting a new cycle',
      { stalled_ms: elapsed, max_cycle_ms: maxCycleMs },
    );
  }

  const token = ++cycleSeq;
  activeCycleToken = token;
  activeCycleStartedAt = Date.now();
  const cycleStartedAt = activeCycleStartedAt;

  try {
    // Read once per cycle so the value is stable within the cycle (preserves the
    // old module-level const semantics; getWorkerConfig is memoized so this is the
    // same value every cycle).
    const batchSize = readBatchSize();
    const dispatchTimeoutMs = readDispatchTimeoutMs();
    const watchdogStaleSecs = Math.floor(readWatchdogStaleMs() / 1000);
    const drainBudgetMs = readDrainBudgetMs();

    // ── Phase 1: Watchdog recovery (separate transaction) ───────────
    // Runs in its own transaction so a timeout or failure here
    // doesn't block the dispatch phase.
    try {
      await runOutboxWatchdogRecovery(sql, watchdogStaleSecs, logger);
    } catch (watchdogError) {
      logger.error(
        'Watchdog recovery failed (continuing to dispatch)',
        toError(watchdogError),
      );
    }

    // ── Phase 2 + 3: Claim (atomic, outside BullMQ) then bulk-dispatch ──
    // Loops while the claim comes back FULL and the drain budget holds; a
    // short batch means the claimable backlog is empty, so the cycle ends.
    let batches = 0;
    for (;;) {
      const entries = await claimPendingBatch(batchSize);
      if (entries.length === 0) return;
      batches += 1;

      logger.log('Found pending entries', { count: entries.length, batch: batches });
      const anyGroupFailed = await dispatchBatch(entries, dispatchTimeoutMs, logger);

      if (entries.length < batchSize) return;
      // A failed group was re-pended with available_at untouched, so the very
      // next claim in this loop would pick it straight back up (claims order by
      // available_at), bump attempts, fail again, and burn the whole retry
      // budget inside ONE tick against a fast-failing Redis (-OOM/-READONLY
      // reply errors, not a parked socket). Stop at one batch per tick on
      // failure — exactly the outage tolerance the per-row poller had.
      if (anyGroupFailed) {
        logger.log('Dispatch failure in this batch; leaving the remainder for the next tick', {
          batches,
        });
        return;
      }
      const elapsedMs = Date.now() - cycleStartedAt;
      if (elapsedMs >= drainBudgetMs) {
        logger.log('Drain budget spent with a full batch; remainder waits for the next tick', {
          batches,
          elapsed_ms: elapsedMs,
          drain_budget_ms: drainBudgetMs,
        });
        return;
      }
    }
  } catch (error) {
    logger.error('Poll cycle failed', toError(error));
  } finally {
    // Only clear if we're still the active cycle: a wedged predecessor whose
    // hung await eventually settles must not clear a newer cycle's guard.
    if (activeCycleToken === token) {
      activeCycleToken = null;
    }
  }
}

export function startOutboxPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  const pollIntervalMs = readPollIntervalMs();
  logger.log('Starting', {
    interval_ms: pollIntervalMs,
    batch: readBatchSize(),
    dispatch_timeout_ms: readDispatchTimeoutMs(),
    max_cycle_ms: readMaxCycleMs(),
    drain_budget_ms: readDrainBudgetMs(),
    watchdog_stale_ms: readWatchdogStaleMs(),
  });
  pollOutbox().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    pollOutbox().catch(logUnhandledPollError(LOG_PREFIX));
  }, pollIntervalMs);
}

export function stopOutboxPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
