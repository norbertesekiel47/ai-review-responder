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
// subscription-blocked and already-exists branches) carries it. This is kept
// here — not in the caller — to preserve the original worker's log-field
// ordering across all outcome paths.

import { sql } from '../../../src/lib/db/server';
import {
  activeOffboardingStateFromProjection,
  isProcessingBlocked,
  type ActiveOffboardingProjection,
} from '../../../src/lib/account-offboarding/gate';
import { checkSubscription, type AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
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

export type LoadOutcome =
  | { kind: 'ready'; ctx: GenerationContext }
  | { kind: 'review_not_found' }
  | { kind: 'business_not_found' }
  | { kind: 'subscription_blocked'; reason: string }
  | { kind: 'already_exists'; existing: { id: string; businessId: string; accountId: string } };

export async function loadGenerationContext(input: {
  reviewId: string;
  businessId: LocationId;
  version: number;
}): Promise<LoadOutcome> {
  const { reviewId, businessId, version } = input;

  const [review] = await sql<{
    id: string;
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    review_date: string;
    detected_language: string;
    review_content_hash: string | null;
  }[]>`
    SELECT id, reviewer_name, star_rating, review_text, review_date, detected_language, review_content_hash
    FROM reviews
    WHERE id = ${reviewId}
      AND business_id = ${businessId}
  `;

  if (!review) {
    return { kind: 'review_not_found' };
  }

  const [business] = await sql<Array<{
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
  } & ActiveOffboardingProjection>>`
    SELECT b.id, b.account_id, b.name, b.category, b.tone, b.products_services, b.staff_names,
           b.highlight_facts, b.avoid_facts, b.sample_responses,
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
    LEFT JOIN LATERAL (
      SELECT id, account_id, mode, status, failed_step, access_ends_at,
             teardown_started_at, purge_after, purge_started_at,
             purge_cancelled_at
      FROM account_offboardings
      WHERE account_id = a.id
        AND terminal_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    ) ao ON TRUE
    WHERE b.id = ${businessId}
  `;

  if (!business) {
    return { kind: 'business_not_found' };
  }

  // Surface account_id on all subsequent log lines (see header note).
  mergeLogContext({ account_id: business.account_id });

  // ── Subscription guard ───────────────────────────────────────────────
  const subCheck = checkSubscription({
    status: business.subscription_status,
    pastDueAt: business.account_past_due_at,
    accountFlags: business.account_flags ?? {},
    workerType: 'generator',
  });

  if (!subCheck.allowed) {
    return { kind: 'subscription_blocked', reason: subCheck.reason };
  }

  const offboardingState = activeOffboardingStateFromProjection(business);
  if (isProcessingBlocked(offboardingState)) {
    return { kind: 'subscription_blocked', reason: 'account_offboarding_blocked' };
  }

  // ── Idempotency check — previous attempt may have committed ──────────
  // The schema enforces UNIQUE (review_id, version). If a previous attempt
  // committed the response + notification outbox but crashed before
  // markOutboxCompleted, detect this BEFORE spending on LLM calls or
  // reserving cost. The generator's Redis cache may have expired. DTO building
  // is pure and only runs on the 'ready' path, so checking here (before the
  // build) does not change the sequence of SQL calls (review, business,
  // existing-response).
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
    };
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
