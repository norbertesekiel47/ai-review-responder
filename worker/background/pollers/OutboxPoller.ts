import * as Sentry from '@sentry/node';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { sql } from '../../../src/lib/db/server';
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';
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

// Watchdog + claim + dispatch in one linear cycle; the branch count is the
// per-row dispatch-failure vocabulary. Pre-existing size — the perf pass only
// parameterized the watchdog window.
// fallow-ignore-next-line complexity
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

  try {
    // Read once per cycle so the value is stable within the cycle (preserves the
    // old module-level const semantics; getWorkerConfig is memoized so this is the
    // same value every cycle).
    const batchSize = readBatchSize();
    const dispatchTimeoutMs = readDispatchTimeoutMs();
    const watchdogStaleSecs = Math.floor(readWatchdogStaleMs() / 1000);

    // ── Phase 1: Watchdog recovery (separate transaction) ───────────
    // Runs in its own transaction so a timeout or failure here
    // doesn't block the dispatch phase.
    try {
      await sql.begin(async (tx) => {
        // If a BullMQ worker crashed after the OutboxPoller marked the entry
        // as 'dispatched' but before the worker marked it as 'completed',
        // the entry is stuck. Reset retryable ones to 'pending'; fail terminal ones.

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

        const [terminated] = await tx<{ count: string }[]>`
          WITH terminated AS (
            UPDATE job_outbox
            SET status = 'failed',
                last_error = 'Stale dispatched entry exceeded max_attempts',
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
    } catch (watchdogError) {
      logger.error(
        'Watchdog recovery failed (continuing to dispatch)',
        toError(watchdogError),
      );
    }

    // ── Phase 2: Claim pending rows (atomic, outside BullMQ) ────────
    const entries = await sql<OutboxEntry[]>`
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

    if (entries.length === 0) return;

    logger.log('Found pending entries', { count: entries.length });

    // ── Phase 3: Dispatch to BullMQ (outside transaction) ───────────
    for (const entry of entries) {
      const queue = topicToQueue[entry.topic];

      if (!queue) {
        logger.error('Unknown topic for outbox entry', { topic: entry.topic, outbox_id: entry.id });
        // Unknown topic means a registration drift between the outbox
        // producer and the queue registry — an operational bug that would
        // otherwise silently turn rows into 'failed' without operator
        // visibility. Capture distinctly (not just a breadcrumb) so it
        // surfaces in the Sentry issues feed rather than only as attached
        // context on the next unrelated exception.
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
        continue;
      }

      try {
        // Postgres.js may return JSONB as a string depending on connection config.
        // Ensure it's a parsed object before passing to BullMQ.
        const payload = typeof entry.payload === 'string'
          ? JSON.parse(entry.payload) as Record<string, unknown>
          : entry.payload;

        // jobId includes attempt count so watchdog-recovered entries get a
        // fresh BullMQ job. Without this, BullMQ treats the re-add as a
        // duplicate of the old completed/failed job and silently drops it.
        // outbox_id is passed in payload so workers can complete the right
        // outbox entry regardless of the BullMQ jobId format.
        // entry.attempts is already incremented by the claim UPDATE above.
        const jobId = `${entry.id}_${entry.attempts}`;
        await withTimeout(
          queue.add(
            entry.topic,
            { ...payload, outbox_id: entry.id, outbox_attempt: entry.attempts },
            { jobId },
          ),
          dispatchTimeoutMs,
          `outbox dispatch ${entry.topic}`,
        );

        Sentry.addBreadcrumb({
          category: 'outbox',
          message: `Dispatched ${entry.topic} (${entry.id})`,
          level: 'info',
        });

        await sql`
          UPDATE job_outbox
          SET status = 'dispatched', dispatched_at = NOW()
          WHERE id = ${entry.id}
            AND status = 'dispatching'
            AND attempts = ${entry.attempts}
        `;
      } catch (dispatchError) {
        logger.error(
          'Failed to dispatch entry',
          { outbox_id: entry.id, topic: entry.topic },
          toError(dispatchError),
        );

        Sentry.addBreadcrumb({
          category: 'outbox',
          message: `Dispatch failed ${entry.topic} (${entry.id})`,
          level: 'error',
        });

        const errorMsg = dispatchError instanceof Error ? dispatchError.message : String(dispatchError);
        if (entry.attempts >= entry.max_attempts) {
          logger.error('Entry exceeded max_attempts, marking as failed', {
            outbox_id: entry.id,
            max_attempts: entry.max_attempts,
          });
          await sql`
            UPDATE job_outbox
            SET status = 'failed', last_error = ${errorMsg}
            WHERE id = ${entry.id}
              AND status = 'dispatching'
              AND attempts = ${entry.attempts}
          `;
        } else {
          // Reset to pending for next poll cycle
          await sql`
            UPDATE job_outbox
            SET status = 'pending', last_error = ${errorMsg}
            WHERE id = ${entry.id}
              AND status = 'dispatching'
              AND attempts = ${entry.attempts}
          `;
        }
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
