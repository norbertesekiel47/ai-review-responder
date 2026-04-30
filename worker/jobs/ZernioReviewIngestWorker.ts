// worker/jobs/ZernioReviewIngestWorker.ts
//
// Handles ingest_zernio_review outbox topic (one row per active connection
// at the firing Zernio account, fanned out by worker/ingress/zernio.ts).
//
// Flow per spec §4.2:
//   1. Subscription guard.
//   2. Verify zernio_connections row still active for (business, account, location).
//   3. Mock-mode short-circuit (markOutboxCompleted + return).
//   4. Walk up to 2 listReviews pages (locationId-scoped).
//   5. Not found → throw ZernioIngestReviewNotFoundError → BullMQ retries →
//      onFailed hook escalates to review_exceptions type='zernio_review_not_found'.
//   6. Verify location segment: missing/unparseable → throw
//      ZernioIngestUnparseableLocationError (also escalates via onFailed).
//      Mismatch → no-op (sibling business's review).
//   7. External reply present → reconcileExternallyAnsweredReview + return.
//   8. Build MonitoredReview; on ZernioReviewNormalizationError → log + complete.
//   9. processReview + markOutboxCompleted.

import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { extractOutboxHandle, markOutboxCompleted } from '../../src/lib/shared/outbox';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { zernioClient } from '../../src/lib/zernio/client';
import {
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '../../src/lib/reviews/zernio-normalize';
import { processReview } from '../../src/lib/reviews/process-review';
import {
  handleZernioIngestError,
  reconcileExternallyAnsweredReview,
} from './zernio-ingest-shared';
import type { IngestZernioReviewPayload } from '../../src/lib/shared/worker-types';
import type { MonitoredReview } from '../../src/lib/reviews/types';
import type { ZernioReview } from '../../src/lib/zernio/types';

export class ZernioIngestReviewNotFoundError extends Error {
  constructor(
    readonly businessId: string,
    readonly zernioAccountId: string,
    readonly zernioLocationId: string,
    readonly zernioReviewId: string,
  ) {
    super(`Zernio review ${zernioReviewId} not found in latest 100 — retrying`);
    this.name = 'ZernioIngestReviewNotFoundError';
  }
}

export class ZernioIngestUnparseableLocationError extends Error {
  constructor(
    readonly businessId: string,
    readonly zernioAccountId: string,
    readonly zernioLocationId: string,
    readonly zernioReviewId: string,
    readonly reviewName: string,
  ) {
    super(`Unparseable Zernio review.name: ${reviewName.slice(0, 200)}`);
    this.name = 'ZernioIngestUnparseableLocationError';
  }
}

export async function handleZernioReviewIngest(job: Job<IngestZernioReviewPayload>): Promise<void> {
  const logger = createWorkerLogger('[ZernioReviewIngestWorker]', job.data.correlation_id);
  const { business_id, zernio_account_id, zernio_location_id, zernio_review_id } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // 1. Subscription guard
  const [biz] = await sql<{ subscription_status: string; updated_at: Date }[]>`
    SELECT subscription_status, updated_at FROM businesses WHERE id = ${business_id}
  `;
  if (!biz || !checkSubscription(biz.subscription_status, biz.updated_at, 'generator').allowed) {
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  // 2. Verify the connection still exists at the same location
  const [conn] = await sql<{ id: string }[]>`
    SELECT id FROM zernio_connections
    WHERE business_id = ${business_id}
      AND zernio_account_id = ${zernio_account_id}
      AND zernio_location_id = ${zernio_location_id}
      AND status = 'active'
  `;
  if (!conn) {
    logger.warn(`Connection mismatch — skipping`);
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  // 3. Mock-mode short-circuit (spec §7)
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    logger.log(`Mock mode — short-circuiting ingest for ${zernio_review_id}`);
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  // 4. Fetch + locate (up to 2 pages = 100 reviews), locationId-scoped.
  let target: ZernioReview | undefined;
  let pageToken: string | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const page = await zernioClient.listReviews(zernio_account_id, {
        locationId: zernio_location_id,
        pageSize: 50,
        pageToken,
      });
      target = page.reviews.find((r) => r.id === zernio_review_id);
      if (target) break;
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    await handleZernioIngestError(
      err, outboxId, attempt as number,
      { business_id, zernio_account_id, zernio_location_id }, logger,
    );
    return;
  }

  if (!target) {
    throw new ZernioIngestReviewNotFoundError(
      business_id, zernio_account_id, zernio_location_id, zernio_review_id,
    );
  }

  // 5. Verify location match — FAIL CLOSED on missing/unparseable.
  const reviewLocationId = extractLocationFromReviewName(target.name);
  if (!reviewLocationId) {
    logger.error(`Review ${zernio_review_id} name has unparseable location: ${target.name}`);
    throw new ZernioIngestUnparseableLocationError(
      business_id, zernio_account_id, zernio_location_id, zernio_review_id, target.name,
    );
  }
  if (reviewLocationId !== zernio_location_id) {
    logger.log(`Review belongs to different location (${reviewLocationId} vs ${zernio_location_id}) — no-op`);
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  // 6. External-reply reconciliation.
  if (target.reviewReply !== null) {
    await reconcileExternallyAnsweredReview(
      target, business_id, zernio_account_id, zernio_location_id, logger,
    );
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  // 7. Process via existing pipeline.
  let monitored: MonitoredReview;
  try {
    monitored = buildZernioMonitoredReview(target, zernio_account_id, zernio_location_id);
  } catch (err) {
    if (err instanceof ZernioReviewNormalizationError) {
      logger.warn(`Skipping malformed review ${zernio_review_id}: ${err.message}`);
      await markOutboxCompleted(outboxId, attempt);
      return;
    }
    throw err;
  }

  await processReview(monitored, business_id, job.data.correlation_id);
  await markOutboxCompleted(outboxId, attempt);
}
