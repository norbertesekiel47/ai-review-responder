import type { AnalyticsEventName } from './events';
import type { CaptureAnalyticsEventInput } from './posthog';

const MS_PER_DAY = 86_400_000;

export interface ActivationCompletedInput {
  accountId: string;
  accountCreatedAt: Date | string;
  responseId: string;
  businessId: string;
  reviewId: string;
  postedAt: Date | string;
}

/**
 * Builds the `activation_completed` event for an account's first posted
 * response, or returns null when the activation falls outside the 0-7 day
 * window. Single authoritative owner of the activation rule and event shape —
 * both the live publisher path and the historical backfill call it, so they
 * cannot drift.
 *
 * The caller must guarantee `responseId` is the account's first posted
 * response; "is-first" is decided in SQL, not here. `uuid = responseId` lets
 * PostHog dedupe identical re-emits (same uuid AND timestamp) — e.g. a re-run
 * of the backfill. It does NOT by itself dedupe a live-vs-backfill collision,
 * because PostHog's dedup key includes `timestamp` and the two paths stamp
 * different times; the backfill's `--before` cutoff keeps those sets disjoint.
 *
 * The returned event omits `timestamp`: live callers let PostHog record the
 * event at send time (now), while the backfill caller sets `timestamp` from
 * the historical `posted_at` after calling this function.
 */
export function buildActivationCompletedEvent(
  input: ActivationCompletedInput,
): CaptureAnalyticsEventInput | null {
  const postedAtMs = new Date(input.postedAt).getTime();
  const accountCreatedAtMs = new Date(input.accountCreatedAt).getTime();
  const daysToActivation = (postedAtMs - accountCreatedAtMs) / MS_PER_DAY;

  if (!Number.isFinite(daysToActivation) || daysToActivation < 0 || daysToActivation > 7) {
    return null;
  }

  return {
    event: 'activation_completed' satisfies AnalyticsEventName,
    distinctId: input.accountId,
    uuid: input.responseId,
    properties: {
      account_id: input.accountId,
      business_id: input.businessId,
      response_id: input.responseId,
      review_id: input.reviewId,
      days_to_activation: Number(daysToActivation.toFixed(4)),
    },
  };
}
