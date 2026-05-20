import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import type { BasePayload } from '../../src/lib/shared/worker-types';
import { claimDemo, completeDemo } from '../../src/lib/demos/lifecycle';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '../../src/lib/shared/outbox';
import {
  finalizeOnboardingDemoCost,
  checkCostThreshold,
} from '../../src/lib/costs/onboarding-demo-cost-guard';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import * as Sentry from '@sentry/node';
import { buildOnboardingDemoSource } from './onboarding-demo/demo-source';
import { resolveOnboardingDemoPlaceId } from './onboarding-demo/place-resolution';
import { releaseOnboardingDemoReservation } from './onboarding-demo/reservation';
import { failOnboardingDemoTerminal } from './onboarding-demo/terminal';

/**
 * Onboarding demo job payload — extends the base payload with the
 * date-string of the cost-guard reservation made at /start so the worker
 * can reconcile pessimistic 20¢ reserve against actual spend.
 */
export interface OnboardingDemoJobPayload extends BasePayload {
  demoId: string;
  googlePlaceId: string;
  businessName: string;
  category?: string;
  googleMapsUrl?: string;
  /** ISO date YYYY-MM-DD — the day the reservation was made at /start. */
  cost_reservation_date?: string;
}

export async function handleOnboardingDemo(
  job: Job<OnboardingDemoJobPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[OnboardingDemoWorker]', job.data.correlation_id);
  const { demoId, businessName, category, cost_reservation_date: reservationDate } = job.data;
  const { googlePlaceId } = job.data;
  const googleMapsUrl = job.data.googleMapsUrl;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Reconcile the cost-guard reservation. On any path where work is NOT
  // done, pass actualCents=0 — finalizeOnboardingDemoCost computes
  // delta = 0 - 20¢ = release the pessimistic reserve.
  const releaseReservation = async () => {
    await releaseOnboardingDemoReservation({
      reservationDate,
      logger,
      finalizeCost: finalizeOnboardingDemoCost,
    });
  };

  // Tier-2: Mock leak guard
  if (isMockMode() && process.env.NODE_ENV === 'production') {
    throw new Error('MOCK_EXTERNAL_APIS must not be true in production');
  }

  // Subscription guard (inverted): if user paid between /start and now,
  // the onboarding demo is no longer relevant. Mark failed so /onboarding/demo
  // can render a graceful notice (NOT completeDemo with empty arrays which
  // would lock the user out via the partial-unique-on-completed index).
  const [biz] = await sql<{ subscription_status: string }[]>`
    SELECT a.subscription_status
    FROM onboarding_demos od
    JOIN businesses b ON b.id = od.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE od.id = ${demoId}
  `;
  if (biz && biz.subscription_status !== 'pending_payment') {
    logger.warn(`Demo ${demoId} account status=${biz.subscription_status}, marking failed`);
    await failOnboardingDemoTerminal({
      demoId,
      outboxId,
      outboxAttempt,
      error: new Error('subscription_state_changed'),
      logger,
    });
    await releaseReservation();
    return;
  }

  const claimResult = await claimDemo('onboarding_demos', demoId, logger);

  if (
    claimResult === 'not_found' ||
    claimResult === 'already_terminal' ||
    claimResult === 'race_lost'
  ) {
    await markOutboxCompleted(outboxId, outboxAttempt);
    await releaseReservation();
    return;
  }

  if (claimResult === 'reset_to_queued') {
    throw new Error(`Demo ${demoId} reset from stale running; will re-dispatch`);
  }

  // claimResult === 'claimed' — proceed.
  try {
    const resolvedGooglePlaceId = await resolveOnboardingDemoPlaceId({
      googlePlaceId,
      googleMapsUrl,
      mockMode: isMockMode(),
    });
    const { result, source } = await buildOnboardingDemoSource({
      demoId,
      googlePlaceId: resolvedGooglePlaceId,
      businessName,
      category,
      logger,
    });

    await completeDemo('onboarding_demos', demoId, outboxId, outboxAttempt, {
      reviews: result.reviews,
      responses: result.responses,
      source,
    });

    // Cost-guard reconciliation. The /start route reserved 20¢ pessimistically;
    // here we adjust the daily counter toward actual spend (typically ~3¢).
    if (reservationDate) {
      const actualCostCents = Math.round(result.metadata.totalCostUsd * 100);
      try {
        await finalizeOnboardingDemoCost(reservationDate, actualCostCents);
      } catch (err) {
        logger.error(`Failed to finalize cost reservation: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Threshold check — best-effort. The demo is already completed in
    // Postgres; a Redis/Sentry hiccup here must NOT cascade into the outer
    // catch and call failDemo, which would flip a successful row to failed.
    try {
      const date = new Date().toISOString().slice(0, 10);
      const { crossed } = await checkCostThreshold('onboarding-demo', date, [50, 90, 100]);
      for (const t of crossed) {
        const level = t === 100 ? 'error' : t >= 90 ? 'warning' : 'info';
        Sentry.captureMessage(`onboarding_demo_cost_threshold_${t}`, {
          level,
          tags: { lane: 'onboarding-demo', threshold: String(t) },
        });
      }
    } catch (thresholdErr) {
      logger.error(
        `Threshold check / Sentry capture failed for demo ${demoId}: ${thresholdErr instanceof Error ? thresholdErr.message : thresholdErr}`,
      );
    }

    logger.log(
      `Onboarding demo ${demoId} completed (${source}): ${result.responses.filter(Boolean).length}/${result.reviews.length} responses`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Onboarding demo ${demoId} failed: ${message}`);
    await failOnboardingDemoTerminal({
      demoId,
      outboxId,
      outboxAttempt,
      error: new Error(message),
      logger,
    });
    await releaseReservation();
  }
}
