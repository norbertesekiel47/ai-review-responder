import { getWorkerConfig, type WorkerConfig } from '../../../src/lib/config/worker';
import { zernioPublishingEnabled, zernioRecentReviewPollDisabled } from '../../../src/lib/publishing/flags';
import { sql } from '../../../src/lib/db/server';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../../src/lib/shared/subscription-guard';
import { NON_TERMINAL_STATUSES } from '../../../src/lib/shared/response-status';
import {
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '../../../src/lib/reviews/zernio-normalize';
import { processReview } from '../../../src/lib/reviews/process-review';
import { zernioClient } from '../../../src/lib/zernio/client';
import { ZernioAuthError } from '../../../src/lib/zernio/errors';
import { applyIngestionAuthErrorFallback } from '../../../src/lib/zernio/auth-error-fallback';
import { detectLikelyPhi, redactPhiForLog } from '../../../src/lib/security/phi-scanner';
import {
  openPhiReviewException,
  reconcileExternallyAnsweredReview,
} from '../../jobs/zernio/zernio-ingest-shared';
import type { ZernioReview } from '../../../src/lib/zernio/types';
import { createWorkerLogger, type WorkerLogger, logUnhandledPollError, toError } from '../../../src/lib/shared/logger';

const LOG_PREFIX = '[ZernioRecentReviewPoller]';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_CONNECT_GRACE_MS = 5 * 60_000;
// Per-cycle bounds (deep-scan §3.7): cap the connections processed per cycle,
// fan out with bounded concurrency, and stop dispatching at a deadline so a
// cycle can never run unbounded against the 5-minute interval.
const DEFAULT_MAX_CONNECTIONS_PER_CYCLE = 100;
const DEFAULT_FAN_OUT_CONCURRENCY = 3;
const DEFAULT_CYCLE_DEADLINE_MS = 4 * 60_000;

interface ConnectionRow {
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
  connected_at: Date | null;
  subscription_status: string;
  past_due_at: Date | null;
  account_flags: AccountFlagsInput;
}

export interface ZernioRecentReviewPollResult {
  connectionsChecked: number;
  connectionsDeferred: number;
  reviewsSeen: number;
  reviewsProcessed: number;
  reviewsReconciled: number;
  reviewsSkipped: number;
  reviewsDeleted: number;
  errors: number;
}

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

// Keyset cursor for the per-cycle connection cap: business_id of the last
// connection dispatched in the previous cycle. Connections are processed in
// business_id order; when a cycle reaches the end of the table the cursor
// wraps to null. In-memory on purpose — a worker restart restarts the
// rotation from the top. That is safe while a full rotation
// (ceil(activeConnections / cap) cycles) completes between restarts; if
// connection count ever grows so a rotation outlasts the worker's restart
// cadence, raise ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS so high-business_id
// connections at the tail aren't repeatedly skipped.
let connectionCursor: string | null = null;

export function resetConnectionCursorForTests(): void {
  connectionCursor = null;
}

// The migrated tuning vars this poller reads (all rawOptionalVar in workerSchema).
// Typing the param to this union keeps getWorkerConfig()[name] type-safe without a
// cast and documents exactly which vars the poller consumes.
type ZernioPollerVar =
  | 'ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS'
  | 'ZERNIO_RECENT_REVIEW_POLL_PAGE_SIZE'
  | 'ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES'
  | 'ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS'
  | 'ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY'
  | 'ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS'
  | 'ZERNIO_RECENT_REVIEW_POLL_INTERVAL_MS';

function readPositiveInt(name: ZernioPollerVar & keyof WorkerConfig, fallback: number): number {
  const parsed = parseInt(getWorkerConfig()[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecentForConnection(review: ZernioReview, connectedAt: Date | null): boolean {
  if (!connectedAt) return false;
  const reviewMs = new Date(review.createTime).getTime();
  const connectedMs = connectedAt.getTime();
  if (!Number.isFinite(reviewMs) || !Number.isFinite(connectedMs)) return false;

  const graceMs = readPositiveInt('ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS', DEFAULT_CONNECT_GRACE_MS);
  return reviewMs >= connectedMs - graceMs;
}

function connectionCutoff(connectedAt: Date | null): Date | null {
  if (!connectedAt) return null;
  const connectedMs = connectedAt.getTime();
  if (!Number.isFinite(connectedMs)) return null;
  const graceMs = readPositiveInt('ZERNIO_RECENT_REVIEW_CONNECT_GRACE_MS', DEFAULT_CONNECT_GRACE_MS);
  return new Date(connectedMs - graceMs);
}

// Keyset pagination by business_id (stable total order) so the per-cycle cap
// still covers every connection across cycles. The previous connected_at DESC
// ordering prioritized newest connections, which only mattered when every
// cycle visited all of them.
async function loadActiveConnections(
  limit: number,
  afterBusinessId: string | null,
): Promise<ConnectionRow[]> {
  return await sql<ConnectionRow[]>`
    SELECT
      zc.business_id,
      zc.zernio_account_id,
      zc.zernio_location_id,
      zc.connected_at,
      a.subscription_status,
      a.past_due_at,
      a.flags AS account_flags
    FROM zernio_connections zc
    JOIN businesses b ON b.id = zc.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE zc.status = 'active'
      AND b.archived_at IS NULL
      AND (${afterBusinessId}::uuid IS NULL OR zc.business_id > ${afterBusinessId}::uuid)
    ORDER BY zc.business_id ASC
    LIMIT ${limit}
  `;
}

async function processZernioReview(
  connection: ConnectionRow,
  review: ZernioReview,
  logger: WorkerLogger,
): Promise<'processed' | 'reconciled' | 'skipped'> {
  if (extractLocationFromReviewName(review.name) !== connection.zernio_location_id) {
    return 'skipped';
  }
  if (!isRecentForConnection(review, connection.connected_at)) {
    return 'skipped';
  }

  if (review.reviewReply != null) {
    await reconcileExternallyAnsweredReview(
      review,
      connection.business_id,
      connection.zernio_account_id,
      connection.zernio_location_id,
      logger,
    );
    return 'reconciled';
  }

  const phi = detectLikelyPhi(review.comment);
  if (phi.matched) {
    logger.warn('Likely PHI detected; skipping', {
      review_id: review.id,
      reasons: phi.reasons.join(','),
      review_text_redacted: redactPhiForLog(review.comment),
    });
    await sql.begin((tx) => openPhiReviewException(tx, {
      businessId: connection.business_id,
      accountId: connection.zernio_account_id,
      locationId: connection.zernio_location_id,
      review,
      reasons: phi.reasons,
      source: 'recent_poller',
    }, logger));
    return 'skipped';
  }

  const monitored = buildZernioMonitoredReview(
    review,
    connection.zernio_account_id,
    connection.zernio_location_id,
  );
  await processReview(monitored, connection.business_id, `zernio-poll:${review.id}`);
  return 'processed';
}

async function tombstoneMissingSourceReviews(
  connection: ConnectionRow,
  sourceReviewIds: Set<string>,
  feedComplete: boolean,
): Promise<number> {
  const cutoff = connectionCutoff(connection.connected_at);
  if (!cutoff || !feedComplete) return 0;

  const providerLocationName =
    `zernio://${connection.zernio_account_id}/locations/${connection.zernio_location_id}`;

  const missing = await sql<{ id: string; provider_review_id: string }[]>`
    SELECT id, provider_review_id
    FROM reviews
    WHERE business_id = ${connection.business_id}
      AND provider = 'zernio'
      AND provider_location_name = ${providerLocationName}
      AND status <> 'deleted'
      AND review_date >= ${cutoff}
      AND provider_review_id <> ALL(${[...sourceReviewIds]}::text[])
  `;

  if (missing.length === 0) return 0;
  const reviewIds = missing.map((r) => r.id);

  await sql`
    UPDATE reviews
    SET status = 'deleted'
    WHERE id = ANY(${reviewIds}::uuid[])
      AND status <> 'deleted'
  `;

  await sql`
    UPDATE responses
    SET status = 'failed',
        posting_error = 'review_deleted_at_source',
        updated_at = NOW()
    WHERE review_id = ANY(${reviewIds}::uuid[])
      AND status = ANY(${[...NON_TERMINAL_STATUSES]}::text[])
  `;

  return missing.length;
}

type FetchOutcome =
  | { reviews: ZernioReview[]; feedComplete: boolean }
  | { error: true };

// Page through a connection's reviews. Returns the collected reviews + whether
// the feed was fully read, or {error:true} after applying the auth-error
// fallback (disconnect) / logging — the caller treats both error kinds the same
// (count one error, skip to the next connection).
async function fetchConnectionReviews(
  connection: ConnectionRow,
  pageSize: number,
  maxPages: number,
  logger: WorkerLogger,
): Promise<FetchOutcome> {
  const reviews: ZernioReview[] = [];
  let feedComplete = false;
  try {
    let pageToken: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await zernioClient.listReviews(connection.zernio_account_id, {
        locationId: connection.zernio_location_id,
        pageSize,
        pageToken,
      });
      reviews.push(...page.reviews);
      if (!page.nextPageToken) {
        feedComplete = true;
        break;
      }
      pageToken = page.nextPageToken;
    }
    return { reviews, feedComplete };
  } catch (err) {
    if (err instanceof ZernioAuthError) {
      await applyIngestionAuthErrorFallback(
        connection.business_id,
        connection.zernio_account_id,
        connection.zernio_location_id,
        err.message,
      );
      logger.warn(
        'disconnected business after Zernio auth failure',
        { business_id: connection.business_id },
        err,
      );
      return { error: true };
    }
    logger.error(
      'listReviews failed',
      { business_id: connection.business_id },
      toError(err),
    );
    return { error: true };
  }
}

// Process every review for a connection, folding outcomes into the running
// result accumulator. Malformed reviews are skipped (not counted as errors).
async function processConnectionReviews(
  connection: ConnectionRow,
  reviews: ZernioReview[],
  result: ZernioRecentReviewPollResult,
  logger: WorkerLogger,
): Promise<void> {
  for (const review of reviews) {
    try {
      const outcome = await processZernioReview(connection, review, logger);
      if (outcome === 'processed') result.reviewsProcessed += 1;
      if (outcome === 'reconciled') result.reviewsReconciled += 1;
      if (outcome === 'skipped') result.reviewsSkipped += 1;
    } catch (err) {
      if (err instanceof ZernioReviewNormalizationError) {
        result.reviewsSkipped += 1;
        logger.warn('Skipping malformed review', { review_id: review.id }, err);
        continue;
      }
      result.errors += 1;
      logger.error(
        'Failed to process review',
        { review_id: review.id },
        toError(err),
      );
    }
  }
}

// Full per-connection pass: subscription gate, Zernio fetch, review
// processing, tombstoning. Mutates the shared result accumulator (safe —
// single-threaded event loop; the fan-out interleaves awaits, not writes).
async function checkConnection(
  connection: ConnectionRow,
  pageSize: number,
  maxPages: number,
  result: ZernioRecentReviewPollResult,
  logger: WorkerLogger,
): Promise<void> {
  result.connectionsChecked += 1;
  const sub = checkSubscription({
    status: connection.subscription_status,
    pastDueAt: connection.past_due_at,
    accountFlags: connection.account_flags ?? {},
    workerType: 'generator',
  });
  if (!sub.allowed) {
    return;
  }

  const fetched = await fetchConnectionReviews(connection, pageSize, maxPages, logger);
  if ('error' in fetched) {
    result.errors += 1;
    return;
  }
  const { reviews, feedComplete } = fetched;
  result.reviewsSeen += reviews.length;

  await processConnectionReviews(connection, reviews, result, logger);

  try {
    result.reviewsDeleted += await tombstoneMissingSourceReviews(
      connection,
      new Set(reviews.map((review) => review.id)),
      feedComplete,
    );
  } catch (err) {
    result.errors += 1;
    logger.error(
      'Failed to tombstone missing reviews',
      { business_id: connection.business_id },
      toError(err),
    );
  }
}

export async function runOnce(): Promise<ZernioRecentReviewPollResult> {
  const logger = createWorkerLogger(LOG_PREFIX);
  const result: ZernioRecentReviewPollResult = {
    connectionsChecked: 0,
    connectionsDeferred: 0,
    reviewsSeen: 0,
    reviewsProcessed: 0,
    reviewsReconciled: 0,
    reviewsSkipped: 0,
    reviewsDeleted: 0,
    errors: 0,
  };

  if (!zernioPublishingEnabled()) {
    return result;
  }

  const pageSize = readPositiveInt('ZERNIO_RECENT_REVIEW_POLL_PAGE_SIZE', DEFAULT_PAGE_SIZE);
  const maxPages = readPositiveInt('ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES', DEFAULT_MAX_PAGES);
  const maxConnections = readPositiveInt(
    'ZERNIO_RECENT_REVIEW_POLL_MAX_CONNECTIONS',
    DEFAULT_MAX_CONNECTIONS_PER_CYCLE,
  );
  const concurrency = readPositiveInt(
    'ZERNIO_RECENT_REVIEW_POLL_CONCURRENCY',
    DEFAULT_FAN_OUT_CONCURRENCY,
  );
  const deadlineMs = readPositiveInt(
    'ZERNIO_RECENT_REVIEW_POLL_DEADLINE_MS',
    DEFAULT_CYCLE_DEADLINE_MS,
  );

  const connections = await loadActiveConnections(maxConnections, connectionCursor);
  const reachedEndOfRotation = connections.length < maxConnections;

  // Budget the deadline against dispatch time, not the DB load — the load is
  // a single keyset query and shouldn't eat into the per-connection budget.
  const startedAt = Date.now();

  // Bounded fan-out: a fixed pool of workers pulls connections in order.
  // `nextIndex` is the shared claim pointer; once the pool drains it equals
  // the number of connections dispatched this cycle. Past the deadline no NEW
  // connection is dispatched (in-flight ones finish), so a slow Zernio cycle
  // degrades by deferring — never by running unbounded into the next interval.
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, connections.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < connections.length) {
        if (Date.now() - startedAt >= deadlineMs) return;
        const connection = connections[nextIndex]!;
        nextIndex += 1;
        // checkConnection contains its own failure modes, but a secondary
        // write (e.g. the auth-error disconnect) can still throw. Contain it
        // here: an unhandled rejection would reject Promise.all, leave the
        // sibling workers running detached, and skip the cursor advance below
        // (re-failing the same batch forever).
        try {
          await checkConnection(connection, pageSize, maxPages, result, logger);
        } catch (err) {
          result.errors += 1;
          logger.error(
            'Connection processing failed',
            { business_id: connection.business_id },
            toError(err),
          );
        }
      }
    }),
  );

  const dispatched = nextIndex;
  result.connectionsDeferred = connections.length - dispatched;
  if (result.connectionsDeferred > 0) {
    // production.md: no silent truncation — say what was dropped and why.
    logger.warn('Cycle deadline reached — deferring connections to the next cycle', {
      deadline_ms: deadlineMs,
      dispatched,
      deferred: result.connectionsDeferred,
    });
  }

  // Cursor = the last connection actually dispatched, so deferred ones lead
  // the next cycle. A fully-drained final batch wraps to the start. A
  // transiently-errored connection is treated as dispatched (it retries on the
  // next rotation, not the next cycle — an accepted latency tradeoff for the
  // per-cycle cap; revisit with per-connection retry tracking if it bites).
  if (dispatched > 0) {
    connectionCursor = connections[dispatched - 1]!.business_id;
  }
  if (result.connectionsDeferred === 0 && reachedEndOfRotation) {
    connectionCursor = null;
  }

  return result;
}

async function poll(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  const logger = createWorkerLogger(LOG_PREFIX);
  try {
    const result = await runOnce();
    if (
      result.reviewsProcessed > 0 ||
      result.reviewsReconciled > 0 ||
      result.reviewsDeleted > 0 ||
      result.connectionsDeferred > 0 ||
      result.errors > 0
    ) {
      logger.log('Poll cycle summary', {
        checked: result.connectionsChecked,
        deferred: result.connectionsDeferred,
        seen: result.reviewsSeen,
        processed: result.reviewsProcessed,
        reconciled: result.reviewsReconciled,
        skipped: result.reviewsSkipped,
        deleted: result.reviewsDeleted,
        errors: result.errors,
      });
    }
  } catch (err) {
    logger.error('Poll cycle failed', toError(err));
  } finally {
    isPolling = false;
  }
}

export function startZernioRecentReviewPoller(): void {
  const logger = createWorkerLogger(LOG_PREFIX);
  if (zernioRecentReviewPollDisabled()) {
    logger.log('Skipped - ZERNIO_RECENT_REVIEW_POLL_DISABLED=true');
    return;
  }
  const intervalMs = readPositiveInt('ZERNIO_RECENT_REVIEW_POLL_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  logger.log('Starting', { interval_ms: intervalMs });
  poll().catch(logUnhandledPollError(LOG_PREFIX));
  pollerInterval = setInterval(() => {
    poll().catch(logUnhandledPollError(LOG_PREFIX));
  }, intervalMs);
}

export function stopZernioRecentReviewPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    createWorkerLogger(LOG_PREFIX).log('Stopped');
  }
}
