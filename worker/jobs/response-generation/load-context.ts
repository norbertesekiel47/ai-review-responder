// worker/jobs/response-generation/load-context.ts
//
// Pre-generation gate for the response generator. Reads the review + business
// rows, builds the NormalizedReview + BusinessContext DTOs, runs the
// subscription guard, and performs the idempotency check (a previous attempt
// may have committed the response but crashed before completing the outbox).
// Returns a discriminated LoadOutcome; the caller maps each outcome to the
// appropriate outbox effect. No outbox writes happen here.

import { sql } from '../../../src/lib/db/server';
import { checkSubscription, type AccountFlagsInput } from '../../../src/lib/shared/subscription-guard';
import { sanitizeText } from '../../../src/lib/shared/sanitize';
import { parseDbArray } from '../../../src/lib/shared/db-array';
import { mergeLogContext } from '../../../src/lib/shared/log-context';
import type { LocationId } from '../../../src/lib/shared/ids';
import type { NormalizedReview } from '../../../src/lib/reviews/types';
import type { BusinessContext } from '../../../src/lib/responses/types';

export interface GenerationContext {
  accountId: string;
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
  }[]>`
    SELECT id, reviewer_name, star_rating, review_text, review_date, detected_language
    FROM reviews WHERE id = ${reviewId}
  `;

  if (!review) {
    return { kind: 'review_not_found' };
  }

  const [business] = await sql<{
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
  }[]>`
    SELECT b.id, b.account_id, b.name, b.category, b.tone, b.products_services, b.staff_names,
           b.highlight_facts, b.avoid_facts, b.sample_responses,
           a.subscription_status, a.subscription_tier,
           a.past_due_at AS account_past_due_at, a.flags AS account_flags
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
  `;

  if (!business) {
    return { kind: 'business_not_found' };
  }

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
    FROM responses r
    JOIN businesses b ON b.id = r.business_id
    WHERE r.review_id = ${reviewId}
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
    ctx: { accountId: business.account_id, normalizedReview, businessContext },
  };
}
