import * as Sentry from '@sentry/node';
import { sql } from '../../../src/lib/db/server';
import { createWorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';
import { topicToQueue } from '../../queues';

const LOG_PREFIX = '[OutboxPoller]';

interface OutboxEntry {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

const POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '30000', 10);

function readBatchSize(): number {
  const raw = parseInt(process.env.OUTBOX_BATCH_SIZE || '50', 10);
  if (!Number.isFinite(raw) || raw < 1) return 50;
  if (raw > 500) return 500;
  return raw;
}
const BATCH_SIZE = readBatchSize();

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

export async function pollOutbox(): Promise<void> {
  if (isPolling) return;
  isPolling = true;

  const logger = createWorkerLogger(LOG_PREFIX);

  try {
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
              AND dispatched_at < NOW() - INTERVAL '1 hour'
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
              AND dispatched_at < NOW() - INTERVAL '1 hour'
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
        LIMIT ${BATCH_SIZE}
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
        await queue.add(
          entry.topic,
          { ...payload, outbox_id: entry.id, outbox_attempt: entry.attempts },
          { jobId },
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
    isPolling = false;
  }
}

export function startOutboxPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  logger.log('Starting', { interval_ms: POLL_INTERVAL_MS, batch: BATCH_SIZE });
  pollOutbox().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    pollOutbox().catch(logUnhandledPollError(LOG_PREFIX));
  }, POLL_INTERVAL_MS);
}

export function stopOutboxPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
