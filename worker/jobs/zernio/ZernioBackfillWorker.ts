// worker/jobs/zernio/ZernioBackfillWorker.ts
//
// Consented Review import executor (#675, spec §6.1). Handles the
// zernio_initial_backfill outbox topic. Initial runs are one-shot per
// business; reactivation catch-up runs are keyed by correlation_id.
// Idempotent via zernio_backfill_runs.completed_at IS NOT NULL sentinel.
//
// Selection: newest IMPORT_TARGET_COUNT reviews inside the Import window
// (CONTEXT.md glossary) — createTime in [now − 12 months, live-ingest
// cutoff). The upper bound keeps lane ownership disjoint: the live lane
// (webhook + recent poller) owns createTime >= cutoff, so nothing the
// import stores can be a review the live lane owed a draft for (#674).
//
// Nothing is auto-drafted (D2): unanswered reviews store via importReview
// (no generate_response, no job_outbox row); answered reviews become list
// rows via reconcileExternallyAnsweredReview({ consentedImport: true }) —
// review row + imported 'posted' response, regardless of
// EXTERNAL_REPLY_IMPORT_ENABLED. Answered reviews are not PHI-screened
// worker-side (reconcile owns PHI on its import branches); a PHI-skipped
// answered review still counts imported — the exception row is the audit
// trail.
//
// Counters: writes ONLY imported_count / skipped_count (+
// oldest_skipped_create_time). The four legacy gap_*/historical_* counters
// freeze at DEFAULT 0 — the #673 dual-write contract ended here; #680
// drops them.

import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import type { Sql } from 'postgres';
import * as Sentry from '@sentry/node';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../../src/lib/config/worker';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { isSubscriptionTier } from '../../../src/lib/accounts/tier-config';
import { zernioClient } from '../../../src/lib/zernio/client';
import {
  buildZernioMonitoredReview,
  extractLocationFromReviewName,
  ZernioReviewNormalizationError,
} from '../../../src/lib/reviews/zernio-normalize';
import { importReview } from '../../../src/lib/reviews/process-review';
import {
  handleZernioIngestError,
  liveIngestCutoff,
  reconcileExternallyAnsweredReview,
  screenPhiOrOpenException,
} from './zernio-ingest-shared';
import { guardImportConsent, guardZernioJobEligibility } from './job-eligibility';
import type { ZernioInitialBackfillPayload } from '../../../src/lib/shared/worker-types';
import type { MonitoredReview } from '../../../src/lib/reviews/types';
import type { ZernioReview } from '../../../src/lib/zernio/types';

export const IMPORT_TARGET_COUNT = 100;
export const IMPORT_FLOOR_MONTHS = 12;

export interface ImportSelection {
  /** newest-first, ≤ IMPORT_TARGET_COUNT, every member inside the Import window */
  selected: ZernioReview[];
  /** in-window reviews beyond the ceiling — the skipped_count seed */
  capOverflow: ZernioReview[];
  oldestSkippedCreateTime: string | null;
}

/**
 * Pure selection over the Import window (CONTEXT.md glossary): keep reviews
 * with floorMs <= createTime < upperCutoffMs (upper null = no bound, the
 * connected_at-null case), sort newest-first (defensive re-sort — Zernio's
 * ordering is verified but undocumented, spec §9), take the newest
 * IMPORT_TARGET_COUNT. Unparseable createTime is excluded outright (the
 * normalization path would reject it anyway).
 */
export function selectImportWindow(
  reviews: ZernioReview[],
  opts: { floorMs: number; upperCutoffMs: number | null },
): ImportSelection {
  const inWindow = reviews.filter((z) => {
    const t = new Date(z.createTime).getTime();
    if (!Number.isFinite(t)) return false;
    if (t < opts.floorMs) return false;
    if (opts.upperCutoffMs !== null && t >= opts.upperCutoffMs) return false;
    return true;
  });
  const sorted = [...inWindow].sort(
    (a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime(),
  );
  const selected = sorted.slice(0, IMPORT_TARGET_COUNT);
  const capOverflow = sorted.slice(IMPORT_TARGET_COUNT);
  // Epoch comparison, NOT string comparison — lexicographic ordering of
  // RFC3339 strings with differing fractional-second lengths misorders
  // ('...00.5Z' vs '...00.500Z' etc.); plan-review r1 MEDIUM.
  const oldestSkippedCreateTime = capOverflow.reduce<string | null>(
    (oldest, z) =>
      !oldest || new Date(z.createTime).getTime() < new Date(oldest).getTime()
        ? z.createTime
        : oldest,
    null,
  );
  return { selected, capOverflow, oldestSkippedCreateTime };
}

/** The page cap was exhausted with nextPageToken still set and fewer than
 *  IMPORT_TARGET_COUNT in-window reviews collected. Loud by design — the
 *  old backfill truncated silently at maxPages: 4 (spec §1). Deterministic,
 *  so it is persisted TERMINALLY (markOutboxFailed + Sentry, no BullMQ
 *  retry churn); completed_at stays NULL so the run remains claimable after
 *  ops bumps ZERNIO_IMPORT_MAX_PAGES (admin re-enqueue, consent permitting). */
class ZernioImportPaginationCapExhaustedError extends Error {
  constructor(
    readonly businessId: string,
    readonly cap: number,
    readonly inWindowCount: number,
    readonly reviewsSeen: number,
  ) {
    super(`Import pagination cap=${cap} pages exhausted with ${inWindowCount}/${IMPORT_TARGET_COUNT} in-window reviews (${reviewsSeen} seen, more pages available)`);
    this.name = 'ZernioImportPaginationCapExhaustedError';
  }
}

export async function handleZernioBackfill(sql: Sql, job: Job<ZernioInitialBackfillPayload>): Promise<void> {
  const logger = createWorkerLogger('[ZernioBackfillWorker]', job.data.correlation_id);
  const {
    business_id,
    zernio_account_id,
    zernio_location_id,
    subscription_tier,
    subscription_activated_at,
    backfill_reason,
  } = job.data;
  if (!isSubscriptionTier(subscription_tier)) {
    throw new Error(`invalid_ws8_subscription_tier:${subscription_tier}`);
  }
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);

  // Fail-closed Import consent gate (#679, spec §5.3) — the FIRST thing this
  // worker does after resolving its outbox handle, and deliberately BEFORE the
  // zernio_backfill_runs INSERT below (owner decision 2026-08-07; this deviates
  // from spec §5.3's literal "joins the existing pre-flight guards" placement).
  // A refused run must leave NO durable trace at all: running it alongside the
  // other guards would mint a claimed zernio_backfill_runs row for an import
  // that must never happen, which an operator would later read as "the import
  // was attempted". Guard internals — transaction, businesses row lock,
  // in-transaction markOutboxCompleted, the derived-expiry fragment — live in
  // job-eligibility.ts.
  //
  // Applies to BOTH backfill_reason values. The reactivation producer
  // (archive-location-tx.ts) already requires 'accepted', and an answered
  // decision outranks its deadline, so a post-Import-window reactivation
  // catch-up for an accepted business still passes.
  //
  // The isSubscriptionTier throw above stays AHEAD of this gate (carve-out,
  // plan T4): an unparseable tier is an impossible state to assert on, no
  // Review import happens on either path, and only the outbox disposition
  // differs (throw/retry rather than skip-complete).
  const consent = await guardImportConsent(sql, {
    businessId: business_id,
    outboxId,
    attempt,
    logger,
  });
  if (consent.kind === 'skipped') {
    return;
  }

  const isReactivationBackfill = backfill_reason === 'reactivation';
  const runReason = isReactivationBackfill ? 'reactivation' : 'initial';
  const correlationId = job.data.correlation_id ?? uuidv7();

  // Idempotent claim — insert only if no row exists yet for this business.
  // The reactivation branch names NO counter column (initial never did):
  // the collapsed counters AND the four frozen legacy counters are all
  // NOT NULL DEFAULT 0 (migrations 028 + 100), so DEFAULT owns them.
  const runId = uuidv7();
  if (isReactivationBackfill) {
    await sql`
      INSERT INTO zernio_backfill_runs (
        id, business_id, zernio_account_id, zernio_location_id,
        subscription_tier, subscription_activated_at, run_reason, correlation_id,
        completed_at, oldest_skipped_create_time, started_at, updated_at
      ) VALUES (
        ${runId}, ${business_id}, ${zernio_account_id}, ${zernio_location_id},
        ${subscription_tier}, ${subscription_activated_at}, ${runReason}, ${correlationId}::uuid,
        NULL, NULL, NOW(), NOW()
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
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }

  // Shared pre-flight gates (archived-location, subscription) — guard ordering
  // + skip semantics live in job-eligibility.ts. Its row-missing branch is
  // UNREACHABLE for this worker as of #679: guardImportConsent runs first and a
  // missing businesses row yields no consent state, so the fail-closed gate
  // intercepts it and logs { reason: 'missing' } instead of
  // subscription_status=missing. That is deliberate — do not restore a backfill
  // assertion on the old line.
  //
  // On skip the OUTBOX row completes, but completed_at on the
  // zernio_backfill_runs row is NOT set — billing may be restored later
  // (past_due → active, pending_payment → active) or the location un-archived,
  // and the owner deserves a backfill at that point. A future reconnect (or
  // ops-triggered re-enqueue, consent permitting) retries via the same
  // zernio_backfill_runs row (completed_at IS NULL → idempotent re-entry).
  const eligibility = await guardZernioJobEligibility(sql, {
    businessId: business_id,
    outboxId,
    attempt,
    logger,
    jobKind: 'backfill',
  });
  if (eligibility.kind === 'skipped') {
    return;
  }

  // Live-ingest cutoff: read connected_at from the active connection.
  const [conn] = await sql<{ connected_at: Date | null }[]>`
    SELECT connected_at FROM zernio_connections
    WHERE business_id = ${business_id}
      AND zernio_account_id = ${zernio_account_id}
      AND zernio_location_id = ${zernio_location_id}
      AND status = 'active'
  `;
  if (!conn) {
    logger.warn(`No active connection for business=${business_id} — skipping import (completed_at left NULL)`);
    await markOutboxCompleted(sql, outboxId, attempt);
    return;
  }
  const cutoff = liveIngestCutoff(conn.connected_at);
  const upperCutoffMs = cutoff ? cutoff.getTime() : null;
  const floor = new Date();
  floor.setMonth(floor.getMonth() - IMPORT_FLOOR_MONTHS);
  const floorMs = floor.getTime();

  // Page until the target is met (spec §6.1). Newest-first ordering is
  // verified but undocumented (spec §9) — a non-descending page logs a
  // warning and disables BOTH early stops for this run (target and floor):
  // in dirty mode newer reviews may sit on later pages, so stopping at 100
  // could select the wrong newest-100. Dirty mode pages to feed end or cap.
  // Pages are deduped by review id — provider page boundaries may repeat.
  const parsedMaxPages = parseInt(getWorkerConfig().ZERNIO_IMPORT_MAX_PAGES ?? '', 10);
  const maxPages = Number.isFinite(parsedMaxPages) && parsedMaxPages > 0 ? parsedMaxPages : 6;
  const fetchedById = new Map<string, ZernioReview>();
  let pageToken: string | undefined;
  let pagesWalked = 0;
  let orderingClean = true;
  let prevMs = Infinity;
  let capExhaustedWithMorePages = false;
  const currentSelection = () =>
    selectImportWindow(
      // Defense-in-depth client-side filter — only import reviews from this
      // location (mirrors the ingest worker's location check).
      [...fetchedById.values()].filter(
        (z) => extractLocationFromReviewName(z.name) === zernio_location_id,
      ),
      { floorMs, upperCutoffMs },
    );
  try {
    for (let i = 0; i < maxPages; i++) {
      const page = await zernioClient.listReviews(zernio_account_id, {
        locationId: zernio_location_id,
        pageSize: 50,
        pageToken,
      });
      pagesWalked += 1;
      let pageOldestMs = Infinity;
      for (const z of page.reviews) {
        const t = new Date(z.createTime).getTime();
        if (Number.isFinite(t)) {
          if (t > prevMs && orderingClean) {
            orderingClean = false;
            logger.warn(
              `Zernio page order non-descending at review ${z.id} (page ${pagesWalked}) — undocumented ordering changed? Early stops disabled for this run`,
            );
          }
          prevMs = t;
          pageOldestMs = Math.min(pageOldestMs, t);
        }
        if (!fetchedById.has(z.id)) fetchedById.set(z.id, z);
      }
      if (!page.nextPageToken) break;
      // Early stops are trusted ONLY while ordering is clean.
      if (orderingClean && currentSelection().selected.length >= IMPORT_TARGET_COUNT) break;
      if (orderingClean && pageOldestMs < floorMs) break; // everything further back is older
      if (i === maxPages - 1) {
        capExhaustedWithMorePages = true;
        break;
      }
      pageToken = page.nextPageToken;
    }
  } catch (err) {
    await handleZernioIngestError(
      sql, err, outboxId, attempt as number,
      { business_id, zernio_account_id, zernio_location_id }, logger,
    );
    return;
  }

  const selection = currentSelection();

  if (capExhaustedWithMorePages && selection.selected.length < IMPORT_TARGET_COUNT) {
    // TERMINAL, loud, never silent (r1 HIGH-2). The condition is
    // deterministic — BullMQ retries would refetch the same pages — and the
    // backfill queue has no failed-hook, so persist the failure here: named
    // error in the failed outbox row + Sentry. completed_at stays NULL, so
    // after ops bumps ZERNIO_IMPORT_MAX_PAGES the run is still claimable via
    // admin re-enqueue (consent permitting, spec §5.3).
    // (Dirty-ordering cap-outs with >= 100 candidates proceed best-effort
    // instead — the ordering warning is the ops signal there.)
    const err = new ZernioImportPaginationCapExhaustedError(
      business_id, maxPages, selection.selected.length, fetchedById.size,
    );
    logger.error(err.message);
    Sentry.captureException(err);
    // Prefix with err.name so the failed row carries the class.
    await markOutboxFailed(sql, outboxId, `${err.name}: ${err.message}`, attempt);
    return;
  }

  let importedCount = 0;
  let skippedCount = selection.capOverflow.length;
  const reconcileFailures: { reviewId: string; error: string }[] = [];

  for (const z of selection.selected) {
    // Loose-equality: an omitted reviewReply on the wire is 'unanswered'.
    if (z.reviewReply != null) {
      try {
        await reconcileExternallyAnsweredReview(
          sql, z, business_id, zernio_account_id, zernio_location_id, logger,
          { consentedImport: true },
        );
        importedCount += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Import reconcile failed for review ${z.id}: ${msg}`);
        reconcileFailures.push({ reviewId: z.id, error: msg });
      }
      continue;
    }

    if (await screenPhiOrOpenException(sql, {
        businessId: business_id,
        accountId: zernio_account_id,
        locationId: zernio_location_id,
        review: z,
        source: 'backfill',
      }, logger)) {
      skippedCount += 1;
      continue;
    }

    let monitored: MonitoredReview;
    try {
      monitored = buildZernioMonitoredReview(z, zernio_account_id, zernio_location_id);
    } catch (err) {
      if (err instanceof ZernioReviewNormalizationError) {
        logger.warn(`Skipping malformed review ${z.id}: ${err.message}`);
        skippedCount += 1;
        continue;
      }
      throw err;
    }
    // 'unchanged' (row already existed / concurrent writer won) still counts
    // imported — the review IS in the owner's list either way.
    await importReview(sql, monitored, business_id, job.data.correlation_id);
    importedCount += 1;
  }

  // Always update partial counts so ops can audit even on retry.
  await sql`
    UPDATE zernio_backfill_runs
    SET imported_count = ${importedCount},
        skipped_count = ${skippedCount},
        oldest_skipped_create_time = ${selection.oldestSkippedCreateTime},
        updated_at = NOW()
    WHERE id = ${run.id}
  `;

  if (reconcileFailures.length > 0) {
    throw new Error(
      `Import reconciliation failed for ${reconcileFailures.length} review(s): ` +
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
    `Import complete business=${business_id}: imported=${importedCount} skipped=${skippedCount} ` +
    `pages=${pagesWalked} window=[${new Date(floorMs).toISOString()}, ${cutoff ? cutoff.toISOString() : 'unbounded'})`,
  );

  await markOutboxCompleted(sql, outboxId, attempt);
}
