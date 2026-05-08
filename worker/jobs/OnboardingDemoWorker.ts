import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import type { BasePayload } from '../../src/lib/shared/worker-types';
import { fetchSerpApiReviews } from '../../src/lib/demos/fetch-reviews';
import { selectQualifyingReviews } from '../../src/lib/demos/select-qualifying';
import { generateResponsesForReviews } from '../../src/lib/demos/generate-responses';
import { getFallbackDemo } from '../../src/lib/demos/fallback-content';
import { claimDemo, completeDemo, failDemo } from '../../src/lib/demos/lifecycle';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '../../src/lib/shared/outbox';
import { isPlaceId, parseGoogleMapsUrl } from '../../src/lib/reviews/url-parser';
import { resolvePlaceId } from '../../src/lib/reviews/place-id-resolver';
import {
  finalizeOnboardingDemoCost,
  checkCostThreshold,
} from '../../src/lib/costs/onboarding-demo-cost-guard';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import * as Sentry from '@sentry/node';
import type { NormalizedReview } from '../../src/lib/reviews/types';
import type { GenerationResult } from '../../src/lib/responses/types';

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
  let { googlePlaceId } = job.data;
  const googleMapsUrl = job.data.googleMapsUrl;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Reconcile the cost-guard reservation. On any path where work is NOT
  // done, pass actualCents=0 — finalizeOnboardingDemoCost computes
  // delta = 0 - 20¢ = release the pessimistic reserve.
  const releaseReservation = async () => {
    if (reservationDate) {
      try {
        await finalizeOnboardingDemoCost(reservationDate, 0);
      } catch (err) {
        logger.error(`Failed to release cost reservation: ${err instanceof Error ? err.message : err}`);
      }
    }
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
    try {
      await failDemo(
        'onboarding_demos',
        demoId,
        outboxId,
        outboxAttempt,
        new Error('subscription_state_changed'),
      );
    } catch (txError) {
      logger.error(
        `Failed to record subscription_state_changed for demo ${demoId}: ${txError instanceof Error ? txError.message : String(txError)}`,
      );
      throw txError;
    }
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
    if (!isPlaceId(googlePlaceId)) {
      if (isMockMode()) {
        // In mock mode fetchSerpApiReviews is stubbed — any non-empty string
        // works as the place identifier. Skip the real SerpAPI resolution.
        googlePlaceId = googlePlaceId || 'mock-place-id';
      } else if (googleMapsUrl) {
        const urlData = parseGoogleMapsUrl(googleMapsUrl);
        googlePlaceId = await resolvePlaceId(urlData);
      } else {
        throw new Error('Invalid Place ID and no URL available for resolution');
      }
    }

    let result: {
      reviews: NormalizedReview[];
      responses: (GenerationResult | null)[];
      metadata: { totalCostUsd: number };
    };
    let source: 'serpapi' | 'curated_fallback';

    // SerpAPI fetch + review-selection failures should NOT fail the demo —
    // the spec calls for graceful degradation to curated fallback so the user
    // still sees something compelling and the paywall stays in front of them.
    // Hard failure is reserved for downstream stages: invalid place resolution
    // (above) and total LLM provider failure (caught below by the outer catch).
    let selected: NormalizedReview[] = [];
    let serpapiOk = true;
    try {
      const reviews = await fetchSerpApiReviews(googlePlaceId);
      selected = selectQualifyingReviews(reviews, { rule: 'positive-with-moderate-tail' });
    } catch (serpErr) {
      serpapiOk = false;
      logger.warn(
        `SerpAPI fetch failed for demo ${demoId}; falling back to curated content: ${serpErr instanceof Error ? serpErr.message : serpErr}`,
      );
    }

    const hasAnchor = selected.some((r) => r.starRating >= 4);
    if (serpapiOk && hasAnchor) {
      result = await generateResponsesForReviews(selected, {
        name: businessName,
        category: category ?? null,
      });
      source = 'serpapi';
    } else {
      const fallback = getFallbackDemo(category ?? null);
      result = {
        reviews: fallback.reviews,
        responses: fallback.responses,
        metadata: { totalCostUsd: 0 },
      };
      source = 'curated_fallback';
    }

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
    try {
      await failDemo('onboarding_demos', demoId, outboxId, outboxAttempt, new Error(message));
    } catch (txError) {
      logger.error(
        `Failed to record failure for demo ${demoId}: ${txError instanceof Error ? txError.message : String(txError)}`,
      );
      throw txError;
    }
    await releaseReservation();
  }
}
