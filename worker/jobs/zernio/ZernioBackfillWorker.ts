// worker/jobs/zernio/ZernioBackfillWorker.ts
//
// Handles zernio_initial_backfill outbox topic. Initial runs are one-shot per
// business; reactivation catch-up runs are keyed by correlation_id.
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
import { sql } from '../../../src/lib/db/server';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../../src/lib/shared/subscription-guard';
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
import { GENERATE_RESPONSE_ORIGIN_LANE } from '../../../src/lib/shared/worker-types';
import {
  handleZernioIngestError,
  openPhiReviewException,
  reconcileExternallyAnsweredReview,
} from './zernio-ingest-shared';
import type { ZernioInitialBackfillPayload } from '../../../src/lib/shared/worker-types';
import type { MonitoredReview } from '../../../src/lib/reviews/types';
import type { ZernioReview } from '../../../src/lib/zernio/types';

export async function handleZernioBackfill(job: Job<ZernioInitialBackfillPayload>): Promise<void> {
  const logger = createWorkerLogger('[ZernioBackfillWorker]', job.data.correlation_id);
  const {
    business_id,
    zernio_account_id,
    zernio_location_id,
    subscription_tier,
    subscription_activated_at,
    backfill_reason,
  } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
  const isReactivationBackfill = backfill_reason === 'reactivation';
  const runReason = isReactivationBackfill ? 'reactivation' : 'initial';
  const correlationId = job.data.correlation_id ?? uuidv7();

  // Idempotent claim — insert only if no row exists yet for this business.
  const runId = uuidv7();
  if (isReactivationBackfill) {
    await sql`
      INSERT INTO zernio_backfill_runs (
        id, business_id, zernio_account_id, zernio_location_id,
        subscription_tier, subscription_activated_at, run_reason, correlation_id,
        completed_at,
        gap_processed_count, historical_processed_count,
        gap_skipped_count, historical_skipped_count,
        oldest_skipped_create_time, started_at, updated_at
      ) VALUES (
        ${runId}, ${business_id}, ${zernio_account_id}, ${zernio_location_id},
        ${subscription_tier}, ${subscription_activated_at}, ${runReason}, ${correlationId}::uuid,
        NULL,
        0, 0, 0, 0, NULL, NOW(), NOW()
      )
      ON CONFLICT (correlation_id) WHERE correlation_id IS NOT NULL DO NOTHING
    `;
  } else {
    await sql`
      INSERT INTO zernio_backfill_runs (
        id, business_id, zernio_account_id, zernio_location_id,
        subscription_tier, subscription_activated_at, run_reason, correlation_id
      ) VALUES (
        ${runId}, ${business_id}, ${zernio_account_id}, ${zernio_location_id},
        ${subscription_tier}, ${subscription_activated_at}, ${runReason}, ${correlationId}::uuid
      )
      ON CONFLICT (business_id) WHERE run_reason = 'initial' DO NOTHING
    `;
  }

  const [run] = isReactivationBackfill
    ? await sql<{ id: string; completed_at: Date | null }[]>`
        SELECT id, completed_at
        FROM zernio_backfill_runs
        WHERE correlation_id = ${correlationId}::uuid
        LIMIT 1
      `
    : await sql<{ id: string; completed_at: Date | null }[]>`
        SELECT id, completed_at
        FROM zernio_backfill_runs
        WHERE business_id = ${business_id}
          AND run_reason = 'initial'
        LIMIT 1
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
  const [acct] = await sql<{
    subscription_status: string;
    past_due_at: Date | null;
    account_flags: AccountFlagsInput;
    archived_at: Date | null;
  }[]>`
    SELECT a.subscription_status, a.past_due_at, a.flags AS account_flags, b.archived_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${business_id}
  `;

  // Archived-location guard (skip-as-success), checked BEFORE the
  // subscription branch (project convention: archived-before-subscription).
  // Mirrors the ingest worker: archived locations keep status='active'
  // connections for reactivation, so a queued backfill for an archived
  // location must complete without walking listAllReviews. Like the
  // subscription skip, completed_at on the zernio_backfill_runs row is NOT
  // set — un-archiving re-enters the same row idempotently.
  if (acct?.archived_at) {
    logger.log('archived — skipping backfill', { reason: 'archived_location', business_id });
    await markOutboxCompleted(outboxId, attempt);
    return;
  }

  if (!acct || !checkSubscription({
    status: acct.subscription_status,
    pastDueAt: acct.past_due_at,
    accountFlags: acct.account_flags ?? {},
    workerType: 'generator',
  }).allowed) {
    logger.log(
      `Backfill skipped for business=${business_id}: subscription_status=${acct?.subscription_status ?? 'missing'}`,
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
  if (Number.isNaN(activeSinceMs)) {
    // Malformed ISO string — without this guard, all >= comparisons evaluate
    // false, producing gap=[] and (non-premium) historical=[], silently
    // completing the backfill with 0 reviews processed. Throw → BullMQ
    // retry → exhaustion surfaces in the failed outbox row for ops.
    throw new Error(
      `[ZernioBackfillWorker] malformed subscription_activated_at for business=${business_id}: ${JSON.stringify(subscription_activated_at)}`,
    );
  }

  // Defense-in-depth client-side filter — only process reviews from this location.
  const locationScoped = all.filter(
    (z) => extractLocationFromReviewName(z.name) === zernio_location_id,
  );

  // Loose-equality so an omitted (undefined) reviewReply on the Zernio
  // wire is treated as 'unanswered'. listReviews normalizes to null today,
  // but defense-in-depth — see Code Review fix Medium 1 (2026-05-02).
  const answered = locationScoped.filter((z) => z.reviewReply != null);
  const unanswered = locationScoped
    .filter((z) => z.reviewReply == null)
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

  const isPremium = subscription_tier === 'premium';
  const GAP_CAP = 25;
  const HISTORICAL_CAP_PREMIUM = 50;

  const gapAll = unanswered.filter((z) => new Date(z.createTime).getTime() >= activeSinceMs);
  const histAll = unanswered.filter((z) => new Date(z.createTime).getTime() < activeSinceMs);

  const gap = gapAll.slice(0, GAP_CAP);
  const historical = isPremium ? histAll.slice(0, HISTORICAL_CAP_PREMIUM) : [];

  const gapSkipped = gapAll.length - gap.length;
  const historicalSkipped = isPremium
    ? histAll.length - historical.length
    : histAll.length;
  const oldestSkipped = [...gapAll.slice(GAP_CAP), ...histAll.slice(historical.length)]
    .reduce((oldest: string | null, z) =>
      !oldest || z.createTime < oldest ? z.createTime : oldest, null);

  let gapProcessed = 0;
  let historicalProcessed = 0;

  async function processUnansweredReview(z: ZernioReview, bucket: 'gap' | 'historical') {
    const phi = detectLikelyPhi(z.comment);
    if (phi.matched) {
      logger.warn(
        `Likely PHI detected for backfill review ${z.id}; reasons=${phi.reasons.join(',')}; review_text=${redactPhiForLog(z.comment)}; skipping`,
      );
      await sql.begin((tx) => openPhiReviewException(tx, {
        businessId: business_id,
        accountId: zernio_account_id,
        locationId: zernio_location_id,
        review: z,
        reasons: phi.reasons,
        source: 'backfill',
      }, logger));
      return;
    }

    let monitored: MonitoredReview;
    try {
      monitored = buildZernioMonitoredReview(z, zernio_account_id, zernio_location_id);
    } catch (err) {
      if (err instanceof ZernioReviewNormalizationError) {
        logger.warn(`Skipping malformed review ${z.id}: ${err.message}`);
        return;
      }
      throw err;
    }
    await processReview(monitored, business_id, job.data.correlation_id, {
      suppressNotification: true,
      originLane: GENERATE_RESPONSE_ORIGIN_LANE.BACKFILL,
    });
    if (bucket === 'gap') {
      gapProcessed++;
    } else {
      historicalProcessed++;
    }
  }

  for (const z of gap) {
    await processUnansweredReview(z, 'gap');
  }
  for (const z of historical) {
    await processUnansweredReview(z, 'historical');
  }

  // Always update partial counts so ops can audit even on retry.
  await sql`
    UPDATE zernio_backfill_runs
    SET gap_processed_count = ${gapProcessed},
        historical_processed_count = ${historicalProcessed},
        gap_skipped_count = ${gapSkipped},
        historical_skipped_count = ${historicalSkipped},
        oldest_skipped_create_time = ${oldestSkipped},
        updated_at = NOW()
    WHERE id = ${run.id}
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
    WHERE id = ${run.id}
  `;

  logger.log(
    `Backfill complete business=${business_id} tier=${subscription_tier}: ` +
    `gap=${gap.length}/${gapAll.length} historical=${historical.length}/${histAll.length}`,
  );

  await markOutboxCompleted(outboxId, attempt);
}
