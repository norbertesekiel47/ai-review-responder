// worker/jobs/response-generation/load-context.ts
//
// Pre-generation gate for the response generator. Reads the review + business
// rows, builds the NormalizedReview + BusinessContext DTOs, runs the
// subscription guard, and performs the idempotency check (a previous attempt
// may have committed the response but crashed before completing the outbox).
// Returns a discriminated LoadOutcome; the caller maps each outcome to the
// appropriate outbox effect. No outbox writes happen here.
//
// One side effect: once the business is read, this merges account_id into the
// worker log context so EVERY subsequent log line (including the
// skipped and already-exists branches) carries it. This is kept
// here — not in the caller — to preserve the original worker's log-field
// ordering across all outcome paths.

import type { Sql } from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isProcessingBlocked,
  type ActiveOffboardingProjection,
} from '../../../src/lib/account-offboarding/gate';
import { checkSubscription, type AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../../src/lib/shared/worker-types';
import { sanitizeText } from '../../../src/lib/shared/sanitize';
import { parseDbArray } from '../../../src/lib/shared/db-array';
import { mergeLogContext } from '../../../src/lib/shared/log-context';
import type { LocationId } from '../../../src/lib/shared/ids';
import type { NormalizedReview } from '../../../src/lib/reviews/types';
import type { BusinessContext } from '../../../src/lib/responses/types';

export interface GenerationContext {
  accountId: string;
  loadedReviewContentHash: string | null;
  normalizedReview: NormalizedReview;
  businessContext: BusinessContext;
}

// Row shapes of the two SQL projections below. Exported so the test fixtures
// (load-context-fixtures.ts) stay type-locked to the SELECT lists — a column
// added to a query without updating its row type fails typecheck.
export interface GenerationReviewRow {
  id: string;
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
  review_date: string;
  detected_language: string;
  review_content_hash: string | null;
}

export interface GenerationBusinessRow extends ActiveOffboardingProjection {
  id: string;
  account_id: string;
  name: string;
  category: string | null;
  tone: string;
  products_services: string | null;
  staff_names: string[] | null;
  highlight_facts: string[] | null;
  avoid_facts: string[] | null;
  sample_responses: string[] | null;
  subscription_status: string;
  subscription_tier: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  archived_at: Date | null;
}

export type LoadOutcome =
  | { kind: 'ready'; ctx: GenerationContext }
  | { kind: 'review_not_found' }
  | { kind: 'business_not_found' }
  // Skip-as-success: the caller logs { reason } and completes the outbox.
  // reason is SKIP_REASON_ARCHIVED_LOCATION, a subscription-guard reason
  // ('cancelled', 'past_due_expired', …), or 'account_offboarding_blocked'.
  | { kind: 'skipped'; reason: string }
  // processingBlocked: account is in active offboarding (delete_data/purge
  // lanes). The outbox-completion recovery still applies — the work WAS done
  // — but the caller must suppress the durable analytics enqueue: a fresh
  // analytics_events row for an account mid-purge is exported to PostHog by
  // a poller with no offboarding gate and can land after purge verification.
  | {
      kind: 'already_exists';
      existing: { id: string; businessId: string; accountId: string };
      processingBlocked: boolean;
    };

export async function loadGenerationContext(sql: Sql, input: {
  reviewId: string;
  businessId: LocationId;
  version: number;
}): Promise<LoadOutcome> {
  const { reviewId, businessId, version } = input;

  const [review] = await sql<GenerationReviewRow[]>`
    SELECT id, reviewer_name, star_rating, review_text, review_date, detected_language, review_content_hash
    FROM reviews
    WHERE id = ${reviewId}
      AND business_id = ${businessId}
  `;

  if (!review) {
    return { kind: 'review_not_found' };
  }

  const [business] = await sql<GenerationBusinessRow[]>`
    SELECT b.id, b.account_id, b.name, b.category, b.tone, b.products_services, b.staff_names,
           b.highlight_facts, b.avoid_facts, b.sample_responses, b.archived_at,
           a.subscription_status, a.subscription_tier,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags,
           ao.id AS offboarding_id,
           ao.account_id AS offboarding_account_id,
           ao.mode AS offboarding_mode,
           ao.status AS offboarding_status,
           ao.failed_step AS offboarding_failed_step,
           ao.access_ends_at AS offboarding_access_ends_at,
           ao.teardown_started_at AS offboarding_teardown_started_at,
           ao.purge_after AS offboarding_purge_after,
           ao.purge_started_at AS offboarding_purge_started_at,
           ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    LEFT JOIN account_offboardings ao
      ON ao.account_id = a.id
     AND ao.terminal_at IS NULL
    WHERE b.id = ${businessId}
    ORDER BY ao.created_at DESC NULLS LAST
    LIMIT 1
  `;

  if (!business) {
    return { kind: 'business_not_found' };
  }

  // Surface account_id on all subsequent log lines (see header note).
  mergeLogContext({ account_id: business.account_id });

  // ── Idempotency check — previous attempt may have committed ──────────
  // The schema enforces UNIQUE (review_id, version). If a previous attempt
  // committed the response + notification outbox but crashed before
  // markOutboxCompleted, detect this BEFORE spending on LLM calls or
  // reserving cost. The generator's Redis cache may have expired.
  //
  // Ordering: this check runs BEFORE the archived-location gate. A response
  // committed pre-archive on a crash-retry must resolve as 'already_exists'
  // so the caller's maybeEnqueueFirstResponseDrafted recovery still fires —
  // a 'skipped' outcome would silently drop it. Idempotency reflects work
  // already done; the archived gate only prevents NEW spend. The same
  // ordering applies to the subscription/offboarding guards below: a response
  // already committed on a now-cancelled or offboarding account still
  // resolves 'already_exists' (the work WAS done) instead of skipping.
  const [existingResponse] = await sql<{ id: string; business_id: string; account_id: string }[]>`
    SELECT r.id, r.business_id, b.account_id
    FROM businesses b
    JOIN responses r ON r.business_id = b.id
    WHERE b.id = ${businessId}
      AND r.review_id = ${reviewId}
      AND r.version = ${version}
  `;

  if (existingResponse) {
    return {
      kind: 'already_exists',
      existing: {
        id: existingResponse.id,
        businessId: existingResponse.business_id,
        accountId: existingResponse.account_id,
      },
      processingBlocked: isProcessingBlocked(activeOffboardingStateFromProjection(business)),
    };
  }

  // ── Archived-location gate ───────────────────────────────────────────
  // Final defense in the spend-leak chain: a job for an archived location
  // (backfill/update lanes, directly-enqueued jobs) must skip BEFORE any paid
  // LLM call. Runs after the idempotency check (see above) but before the
  // subscription guard so a fresh job's skip reason is unambiguously
  // archived_location. The caller skips-as-success.
  if (business.archived_at) {
    return { kind: 'skipped', reason: SKIP_REASON_ARCHIVED_LOCATION };
  }

  // ── Subscription guard ───────────────────────────────────────────────
  const subCheck = checkSubscription({
    status: business.subscription_status,
    pastDueAt: business.account_past_due_at,
    accountFlags: business.account_flags ?? {},
    workerType: 'generator',
  });

  if (!subCheck.allowed) {
    return { kind: 'skipped', reason: subCheck.reason };
  }

  const offboardingState = activeOffboardingStateFromProjection(business);
  if (isProcessingBlocked(offboardingState)) {
    return { kind: 'skipped', reason: 'account_offboarding_blocked' };
  }

  // ── Build DTOs ───────────────────────────────────────────────────────
  const normalizedReview: NormalizedReview = {
    reviewerName: review.reviewer_name,
    starRating: review.star_rating,
    reviewText: review.review_text ? sanitizeText(review.review_text) : null,
    reviewDate: review.review_date,
    detectedLanguage: review.detected_language,
  };

  const businessContext: BusinessContext = {
    id: business.id,
    name: business.name,
    category: business.category,
    tone: business.tone,
    productsServices: business.products_services,
    staffNames: parseDbArray(business.staff_names),
    highlightFacts: parseDbArray(business.highlight_facts),
    avoidFacts: parseDbArray(business.avoid_facts),
    sampleResponses: parseDbArray(business.sample_responses),
    subscriptionTier: business.subscription_tier as BusinessContext['subscriptionTier'],
  };

  return {
    kind: 'ready',
    ctx: {
      accountId: business.account_id,
      loadedReviewContentHash: review.review_content_hash,
      normalizedReview,
      businessContext,
    },
  };
}
