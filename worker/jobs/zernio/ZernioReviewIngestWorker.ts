// worker/jobs/zernio/ZernioReviewIngestWorker.ts
//
// Handles ingest_zernio_review outbox topic (one row per active connection
// at the firing Zernio account, fanned out by worker/ingress/zernio/zernio.ts).
//
// Flow per spec §4.2:
//   1. Shared eligibility gate (job-eligibility.ts): row-missing, then
//      archived-location guard (skip-as-success), then subscription guard.
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
import { sql } from '../../../src/lib/db/server';
import { extractOutboxHandle, markOutboxCompleted } from '../../../src/lib/shared/outbox';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { detectLikelyPhi, redactPhiForLog } from '../../../src/lib/security/phi-scanner';
import { zernioClient } from '../../../src/lib/zernio/client';
import {
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '../../../src/lib/reviews/zernio-normalize';
import { processReview } from '../../../src/lib/reviews/process-review';
import {
  handleZernioIngestError,
  openPhiReviewException,
  reconcileExternallyAnsweredReview,
} from './zernio-ingest-shared';
import { guardZernioJobEligibility } from './job-eligibility';
import type { IngestZernioReviewPayload } from '../../../src/lib/shared/worker-types';
import type { MonitoredReview } from '../../../src/lib/reviews/types';
import type { ZernioReview } from '../../../src/lib/zernio/types';

export class ZernioIngestReviewNotFoundError extends Error {
  constructor(
    readonly businessId: string,
    readonly zernioAccountId: string,
    readonly zernioLocationId: string,
    readonly zernioReviewId: string,
    readonly pagesWalked: number,
    readonly reviewsSeen: number,
  ) {
    super(`Zernio review ${zernioReviewId} not found after walking entire feed (${reviewsSeen} reviews, ${pagesWalked} pages) — review likely deleted on Google`);
    this.name = 'ZernioIngestReviewNotFoundError';
  }
}

/** Thrown when the configured pagination cap is exhausted before the target
 *  review is located AND Zernio still reports more pages available. The
 *  review may exist further back; cap is intentionally bounded to keep
 *  per-job latency + cost predictable. Failed-hook escalates to a distinct
 *  review_exceptions type so ops can either bump the cap or manually
 *  reconcile (rather than treating it as durable not-found). */
export class ZernioIngestPaginationCapExhaustedError extends Error {
  constructor(
    readonly businessId: string,
    readonly zernioAccountId: string,
    readonly zernioLocationId: string,
    readonly zernioReviewId: string,
    readonly cap: number,
    readonly reviewsSeen: number,
  ) {
    super(`Zernio review ${zernioReviewId} not found within pagination cap=${cap} pages (${reviewsSeen} reviews seen, more pages available)`);
    this.name = 'ZernioIngestPaginationCapExhaustedError';
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

  // 1. Shared pre-flight gates (row-missing, archived-location,
  // subscription) — guard ordering + skip semantics live in job-eligibility.ts.
  // Defense-in-depth for jobs already queued when the location was archived:
  // the webhook fan-out no longer enqueues ingest for archived locations, but
  // in-flight jobs must skip too.
  const eligibility = await guardZernioJobEligibility({
    businessId: business_id,
    outboxId,
    attempt,
    logger,
    jobKind: 'ingest',
  });
  if (eligibility.kind === 'skipped') {
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

  // 4. Fetch + locate. Walk up to ZERNIO_INGEST_MAX_PAGES (default 4) =
  // 200 reviews. Distinguish two not-found outcomes:
  //   (a) Walked the entire feed (no nextPageToken at last page) →
  //       durable ZernioIngestReviewNotFoundError. Review likely deleted
  //       on Google or never propagated to Zernio.
  //   (b) Hit the pagination cap with nextPageToken still set →
  //       ZernioIngestPaginationCapExhaustedError. Indeterminate — review
  //       may exist further back; ops decides whether to bump cap or
  //       manually reconcile.
  // The failed-hook in worker/index.ts opens DIFFERENT review_exceptions
  // types for the two cases so ops can triage separately.
  const maxPages = Math.max(1, parseInt(process.env.ZERNIO_INGEST_MAX_PAGES ?? '4', 10) || 4);
  let target: ZernioReview | undefined;
  let pageToken: string | undefined;
  let reviewsSeen = 0;
  let pagesWalked = 0;
  let capExhaustedWithMorePages = false;
  try {
    for (let i = 0; i < maxPages; i++) {
      const page = await zernioClient.listReviews(zernio_account_id, {
        locationId: zernio_location_id,
        pageSize: 50,
        pageToken,
      });
      pagesWalked += 1;
      reviewsSeen += page.reviews.length;
      target = page.reviews.find((r) => r.id === zernio_review_id);
      if (target) break;
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
      // If we're exiting the loop on the LAST iteration with a token still
      // available, mark cap-exhaustion so the post-loop branch routes to
      // the indeterminate error class.
      if (i === maxPages - 1) {
        capExhaustedWithMorePages = true;
      }
    }
  } catch (err) {
    await handleZernioIngestError(
      err, outboxId, attempt as number,
      { business_id, zernio_account_id, zernio_location_id }, logger,
    );
    return;
  }

  if (!target) {
    if (capExhaustedWithMorePages) {
      throw new ZernioIngestPaginationCapExhaustedError(
        business_id, zernio_account_id, zernio_location_id, zernio_review_id,
        maxPages, reviewsSeen,
      );
    }
    throw new ZernioIngestReviewNotFoundError(
      business_id, zernio_account_id, zernio_location_id, zernio_review_id,
      pagesWalked, reviewsSeen,
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

  // 6. External-reply reconciliation. Loose-equality so an omitted
  //    (undefined) reviewReply doesn't get misrouted as 'answered' — see
  //    Code Review fix Medium 1 (2026-05-02).
  if (target.reviewReply != null) {
    await reconcileExternallyAnsweredReview(
      target, business_id, zernio_account_id, zernio_location_id, logger,
    );
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  const phi = detectLikelyPhi(target.comment);
  if (phi.matched) {
    logger.warn(
      `Likely PHI detected for review ${zernio_review_id}; reasons=${phi.reasons.join(',')}; review_text=${redactPhiForLog(target.comment)}`,
    );
    await sql.begin((tx) => openPhiReviewException(tx, {
      businessId: business_id,
      accountId: zernio_account_id,
      locationId: zernio_location_id,
      review: target,
      reasons: phi.reasons,
      source: 'webhook',
    }, logger));
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
