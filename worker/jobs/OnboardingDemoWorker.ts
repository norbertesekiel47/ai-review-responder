import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import type { BasePayload } from '../../src/lib/shared/worker-types';
import { claimDemo, completeDemo } from '../../src/lib/demos/lifecycle';
import type { ClaimResult } from '../../src/lib/demos/types';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '../../src/lib/shared/outbox';
import {
  finalizeOnboardingDemoCost,
  checkCostThreshold,
} from '../../src/lib/costs/onboarding-demo-cost-guard';
import { deploymentLane, requiresProductionConfig } from '../../src/lib/config/deployment-lane';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import {
  finalizeOnboardingDemoSpend,
  reportOnboardingDemoCostThresholds,
} from './onboarding-demo/cost-reconcile';
import { buildOnboardingDemoSource } from './onboarding-demo/demo-source';
import { resolveOnboardingDemoPlaceId } from './onboarding-demo/place-resolution';
import { releaseOnboardingDemoReservation } from './onboarding-demo/reservation';
import { guardOnboardingDemoSubscription } from './onboarding-demo/subscription-guard';
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

/**
 * The three claim outcomes that mean another actor already owns this demo:
 * the row is gone, it already reached a terminal state, or a concurrent
 * worker won the claim CAS. All three complete the outbox and release the
 * reserve; none of them is an error.
 *
 * Named rather than inlined because the grouping is the point — `claimed` and
 * `reset_to_queued` are the two outcomes that still have work attached.
 *
 * Two claims were made for this helper during review and BOTH were wrong; what
 * is left is stated plainly so a third does not accrete.
 *
 * It does NOT make a sixth `ClaimResult` member a compile error. A `===` chain
 * stays valid when a member is ADDED; only removing one breaks it. A new
 * outcome would return false here, fail the `reset_to_queued` test, and fall
 * through to the claimed path — so adding one means revisiting this function
 * by hand.
 *
 * The return type is a predicate rather than `boolean`, but NO current caller
 * depends on the narrowing: `tsc --noEmit` is byte-identical either way. It
 * states the return's meaning in the type instead of in prose, and costs
 * nothing; that is the whole of it.
 *
 * What it actually buys: a name for why these three group, and cyclomatic 10 →
 * 8 in the caller, which is what clears the fallow CRAP threshold with no
 * coverage data present.
 */
function leavesNoWorkToDo(
  claimResult: ClaimResult,
): claimResult is 'not_found' | 'already_terminal' | 'race_lost' {
  return (
    claimResult === 'not_found' ||
    claimResult === 'already_terminal' ||
    claimResult === 'race_lost'
  );
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

  // Tier-2: Mock leak guard. Fires on ANY lane that requires production config —
  // NODE_ENV is unset on the production Railway lane, so asking it left the guard
  // inert exactly where it mattered most (#611). The lane is named because the
  // guard can now trip on staging too, and the operator needs to know which.
  if (isMockMode() && requiresProductionConfig()) {
    throw new Error(`MOCK_EXTERNAL_APIS must not be true on deployment lane "${deploymentLane()}"`);
  }

  // Subscription guard (inverted): if the owner paid between /start and now,
  // the onboarding demo is no longer relevant. The guard owns the read, the
  // decision and its own failure posture; this root only honours the answer.
  const handled = await guardOnboardingDemoSubscription({
    sql,
    demoId,
    outboxId,
    outboxAttempt,
    logger,
    releaseReservation,
    failTerminal: failOnboardingDemoTerminal,
  });
  if (handled) return;

  const claimResult = await claimDemo(sql, 'onboarding_demos', demoId, logger);

  if (leavesNoWorkToDo(claimResult)) {
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
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
    const { result, source } = await buildOnboardingDemoSource(sql, {
      demoId,
      googlePlaceId: resolvedGooglePlaceId,
      businessName,
      category,
      logger,
    });

    await completeDemo(sql, 'onboarding_demos', demoId, outboxId, outboxAttempt, {
      reviews: result.reviews,
      responses: result.responses,
      source,
    });

    // Cost-guard reconciliation, then the threshold alert. Both are
    // best-effort and own their own catch: the demo row is already completed,
    // and an error escaping either would reach the outer catch below and flip
    // a successful row to failed.
    await finalizeOnboardingDemoSpend({
      reservationDate,
      totalCostUsd: result.metadata.totalCostUsd,
      logger,
      finalizeCost: finalizeOnboardingDemoCost,
    });

    await reportOnboardingDemoCostThresholds({
      demoId,
      logger,
      checkThreshold: checkCostThreshold,
    });

    logger.log(
      `Onboarding demo ${demoId} completed (${source}): ${result.responses.filter(Boolean).length}/${result.reviews.length} responses`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Onboarding demo ${demoId} failed: ${message}`);
    try {
      await failOnboardingDemoTerminal({
        sql,
        demoId,
        outboxId,
        outboxAttempt,
        error: new Error(message),
        logger,
      });
    } finally {
      await releaseReservation();
    }
  }
}
