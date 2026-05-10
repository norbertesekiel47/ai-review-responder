import { sql } from '../../../src/lib/db/server';
import { checkSubscription } from '../../../src/lib/shared/subscription-guard';
import { NON_TERMINAL_STATUSES } from '../../../src/lib/shared/response-status';
import {
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '../../../src/lib/reviews/zernio-normalize';
import { processReview } from '../../../src/lib/reviews/process-review';
import { zernioClient } from '../../../src/lib/zernio/client';
import { reconcileExternallyAnsweredReview } from '../../jobs/zernio/zernio-ingest-shared';
import type { ZernioReview } from '../../../src/lib/zernio/types';

const LOG_PREFIX = '[ZernioRecentReviewPoller]';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_CONNECT_GRACE_MS = 5 * 60_000;

interface ConnectionRow {
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
  connected_at: Date | null;
  subscription_status: string;
  updated_at: Date;
}

export interface ZernioRecentReviewPollResult {
  connectionsChecked: number;
  reviewsSeen: number;
  reviewsProcessed: number;
  reviewsReconciled: number;
  reviewsSkipped: number;
  reviewsDeleted: number;
  errors: number;
}

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function readPositiveInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10);
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

async function loadActiveConnections(limit: number, offset: number): Promise<ConnectionRow[]> {
  return await sql<ConnectionRow[]>`
    SELECT
      zc.business_id,
      zc.zernio_account_id,
      zc.zernio_location_id,
      zc.connected_at,
      a.subscription_status,
      a.updated_at
    FROM zernio_connections zc
    JOIN businesses b ON b.id = zc.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE zc.status = 'active'
      AND b.archived_at IS NULL
    ORDER BY zc.connected_at DESC NULLS LAST, zc.business_id ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;
}

async function loadAllActiveConnections(): Promise<ConnectionRow[]> {
  const batchSize = readPositiveInt('ZERNIO_RECENT_REVIEW_POLL_BATCH_SIZE', 50);
  const connections: ConnectionRow[] = [];
  for (let offset = 0; ; offset += batchSize) {
    const batch = await loadActiveConnections(batchSize, offset);
    connections.push(...batch);
    if (batch.length < batchSize) break;
  }
  return connections;
}

async function processZernioReview(
  connection: ConnectionRow,
  review: ZernioReview,
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
      console,
    );
    return 'reconciled';
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

export async function runOnce(): Promise<ZernioRecentReviewPollResult> {
  const result: ZernioRecentReviewPollResult = {
    connectionsChecked: 0,
    reviewsSeen: 0,
    reviewsProcessed: 0,
    reviewsReconciled: 0,
    reviewsSkipped: 0,
    reviewsDeleted: 0,
    errors: 0,
  };

  if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
    return result;
  }

  const connections = await loadAllActiveConnections();
  const pageSize = readPositiveInt('ZERNIO_RECENT_REVIEW_POLL_PAGE_SIZE', DEFAULT_PAGE_SIZE);
  const maxPages = readPositiveInt('ZERNIO_RECENT_REVIEW_POLL_MAX_PAGES', DEFAULT_MAX_PAGES);

  for (const connection of connections) {
    result.connectionsChecked += 1;
    const sub = checkSubscription(
      connection.subscription_status,
      connection.updated_at,
      'generator',
    );
    if (!sub.allowed) {
      continue;
    }

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
      result.reviewsSeen += reviews.length;
    } catch (err) {
      result.errors += 1;
      console.error(`${LOG_PREFIX} listReviews failed for business=${connection.business_id}:`, err);
      continue;
    }

    for (const review of reviews) {
      try {
        const outcome = await processZernioReview(connection, review);
        if (outcome === 'processed') result.reviewsProcessed += 1;
        if (outcome === 'reconciled') result.reviewsReconciled += 1;
        if (outcome === 'skipped') result.reviewsSkipped += 1;
      } catch (err) {
        if (err instanceof ZernioReviewNormalizationError) {
          result.reviewsSkipped += 1;
          console.warn(`${LOG_PREFIX} Skipping malformed review ${review.id}: ${err.message}`);
          continue;
        }
        result.errors += 1;
        console.error(`${LOG_PREFIX} Failed to process review ${review.id}:`, err);
      }
    }

    try {
      result.reviewsDeleted += await tombstoneMissingSourceReviews(
        connection,
        new Set(reviews.map((review) => review.id)),
        feedComplete,
      );
    } catch (err) {
      result.errors += 1;
      console.error(`${LOG_PREFIX} Failed to tombstone missing reviews for business=${connection.business_id}:`, err);
    }
  }

  return result;
}

async function poll(): Promise<void> {
  if (isPolling) return;
  isPolling = true;
  try {
    const result = await runOnce();
    if (
      result.reviewsProcessed > 0 ||
      result.reviewsReconciled > 0 ||
      result.reviewsDeleted > 0 ||
      result.errors > 0
    ) {
      console.log(
        `${LOG_PREFIX} checked=${result.connectionsChecked} seen=${result.reviewsSeen} ` +
        `processed=${result.reviewsProcessed} reconciled=${result.reviewsReconciled} ` +
        `skipped=${result.reviewsSkipped} deleted=${result.reviewsDeleted} errors=${result.errors}`,
      );
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Poll cycle failed:`, err);
  } finally {
    isPolling = false;
  }
}

export function startZernioRecentReviewPoller(): void {
  if (process.env.ZERNIO_RECENT_REVIEW_POLL_DISABLED === 'true') {
    console.log(`${LOG_PREFIX} Skipped - ZERNIO_RECENT_REVIEW_POLL_DISABLED=true`);
    return;
  }
  const intervalMs = readPositiveInt('ZERNIO_RECENT_REVIEW_POLL_INTERVAL_MS', DEFAULT_INTERVAL_MS);
  console.log(`${LOG_PREFIX} Starting (interval=${intervalMs}ms)`);
  poll().catch(console.error);
  pollerInterval = setInterval(() => {
    poll().catch(console.error);
  }, intervalMs);
}

export function stopZernioRecentReviewPoller(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log(`${LOG_PREFIX} Stopped`);
  }
}
