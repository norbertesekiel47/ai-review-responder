// worker/jobs/ZernioBackfillWorker.ts
//
// Handles zernio_initial_backfill outbox topic. One-shot per business.
// Idempotent via zernio_backfill_runs.completed_at IS NOT NULL sentinel —
// row-existence alone is NOT the done marker (a listAllReviews timeout
// after row insert would otherwise lose backfill on retry).
//
// Buckets reviews by createTime vs subscription_activated_at:
//   gap (>= activated, reviewReply=null) → cap 25, all tiers
//   historical (< activated, reviewReply=null) → cap 50, premium only
// Reviews already replied to externally are routed through
// reconcileExternallyAnsweredReview (not bucket-processing) so any
// pre-existing local active draft is correctly superseded.
//
// All processed responses ride suppress_notification=true so the first-
// connect dashboard doesn't blast 75 emails (spec §4.6).

import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
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
import type { ZernioInitialBackfillPayload } from '../../src/lib/shared/worker-types';
import type { MonitoredReview } from '../../src/lib/reviews/types';
import type { ZernioReview } from '../../src/lib/zernio/types';

export async function handleZernioBackfill(job: Job<ZernioInitialBackfillPayload>): Promise<void> {
  const logger = createWorkerLogger('[ZernioBackfillWorker]', job.data.correlation_id);
  const {
    business_id,
    zernio_account_id,
    zernio_location_id,
    subscription_tier,
    subscription_activated_at,
  } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // Idempotent claim — insert only if no row exists yet for this business.
  const runId = uuidv7();
  await sql`
    INSERT INTO zernio_backfill_runs (
      id, business_id, zernio_account_id, zernio_location_id,
      subscription_tier, subscription_activated_at
    ) VALUES (
      ${runId}, ${business_id}, ${zernio_account_id}, ${zernio_location_id},
      ${subscription_tier}, ${subscription_activated_at}
    )
    ON CONFLICT (business_id) DO NOTHING
  `;

  const [run] = await sql<{ id: string; completed_at: Date | null }[]>`
    SELECT id, completed_at FROM zernio_backfill_runs WHERE business_id = ${business_id}
  `;

  if (!run) {
    throw new Error(`Backfill row not found for business=${business_id} after upsert`);
  }
  if (run.completed_at !== null) {
    logger.log(`Backfill already completed for business=${business_id} — skipping`);
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  // Subscription guard. Do NOT set completed_at on skip — billing may be
  // restored later (past_due → active, pending_payment → active) and the
  // owner deserves a backfill at that point. The outbox row is completed
  // so this attempt isn't retried automatically; a future reconnect (or
  // ops-triggered re-enqueue) will retry the backfill via the same
  // zernio_backfill_runs row (completed_at IS NULL → idempotent re-entry).
  const [biz] = await sql<{ subscription_status: string; updated_at: Date }[]>`
    SELECT subscription_status, updated_at FROM businesses WHERE id = ${business_id}
  `;
  if (!biz || !checkSubscription(biz.subscription_status, biz.updated_at, 'generator').allowed) {
    logger.log(
      `Backfill skipped for business=${business_id}: subscription_status=${biz?.subscription_status ?? 'missing'}`,
    );
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  let all: ZernioReview[];
  try {
    all = await zernioClient.listAllReviews(zernio_account_id, {
      locationId: zernio_location_id,
      pageSize: 50,
      maxPages: 4,
    });
  } catch (err) {
    await handleZernioIngestError(
      err, outboxId, attempt as number,
      { business_id, zernio_account_id, zernio_location_id }, logger,
    );
    return;
  }

  const activeSinceMs = new Date(subscription_activated_at).getTime();

  // Defense-in-depth client-side filter — only process reviews from this location.
  const locationScoped = all.filter(
    (z) => extractLocationFromReviewName(z.name) === zernio_location_id,
  );

  const answered = locationScoped.filter((z) => z.reviewReply !== null);
  const unanswered = locationScoped
    .filter((z) => z.reviewReply === null)
    .sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime());

  // Reconcile already-answered reviews. Collect failures; throw at end so
  // BullMQ retries the whole backfill on partial failure (idempotent thanks
  // to processReview ON CONFLICT + supersession idempotency).
  const reconcileFailures: { reviewId: string; error: string }[] = [];
  for (const z of answered) {
    try {
      await reconcileExternallyAnsweredReview(
        z, business_id, zernio_account_id, zernio_location_id, logger,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Backfill reconcile failed for review ${z.id}: ${msg}`);
      reconcileFailures.push({ reviewId: z.id, error: msg });
    }
  }

  const gapAll = unanswered.filter((z) => new Date(z.createTime).getTime() >= activeSinceMs);
  const histAll = unanswered.filter((z) => new Date(z.createTime).getTime() < activeSinceMs);

  const gap = gapAll.slice(0, 25);
  const historical = subscription_tier === 'premium' ? histAll.slice(0, 50) : [];

  const gapSkipped = gapAll.length - gap.length;
  const historicalSkipped = subscription_tier === 'premium'
    ? histAll.length - historical.length
    : histAll.length;
  const oldestSkipped = [...gapAll.slice(25), ...histAll.slice(historical.length)]
    .reduce((oldest: string | null, z) =>
      !oldest || z.createTime < oldest ? z.createTime : oldest, null);

  for (const z of [...gap, ...historical]) {
    let monitored: MonitoredReview;
    try {
      monitored = buildZernioMonitoredReview(z, zernio_account_id, zernio_location_id);
    } catch (err) {
      if (err instanceof ZernioReviewNormalizationError) {
        logger.warn(`Skipping malformed review ${z.id}: ${err.message}`);
        continue;
      }
      throw err;
    }
    await processReview(monitored, business_id, job.data.correlation_id, {
      suppressNotification: true,
    });
  }

  // Always update partial counts so ops can audit even on retry.
  await sql`
    UPDATE zernio_backfill_runs
    SET gap_processed_count = ${gap.length},
        historical_processed_count = ${historical.length},
        gap_skipped_count = ${gapSkipped},
        historical_skipped_count = ${historicalSkipped},
        oldest_skipped_create_time = ${oldestSkipped},
        updated_at = NOW()
    WHERE business_id = ${business_id}
  `;

  if (reconcileFailures.length > 0) {
    throw new Error(
      `Backfill reconciliation failed for ${reconcileFailures.length} review(s): ` +
      reconcileFailures.map((f) => `${f.reviewId} (${f.error})`).join('; ') +
      ` — re-running on retry`,
    );
  }

  // All reconciles succeeded → mark fully completed.
  await sql`
    UPDATE zernio_backfill_runs
    SET completed_at = NOW(), updated_at = NOW()
    WHERE business_id = ${business_id}
  `;

  logger.log(
    `Backfill complete business=${business_id} tier=${subscription_tier}: ` +
    `gap=${gap.length}/${gapAll.length} historical=${historical.length}/${histAll.length}`,
  );

  await markOutboxCompleted(outboxId, attempt);
}
