// src/lib/responses/edit-existing.ts
//
// Two primitives shared by all Past Replies API routes:
//   1. assertCanEditReply — permission gate (tier + ownership).
//   2. validateOptimisticConcurrency — in-tx hash + version check.
//
// Both throw structured errors that map cleanly to HTTP codes in route handlers.
//
// See docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.1, §4.6.

import type postgres from 'postgres';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';
import {
  assertWritableSubscriptionStatus,
  SubscriptionReadOnlyError,
} from '@/lib/shared/writable-subscription';

export { SubscriptionReadOnlyError };

type TxClient = postgres.TransactionSql;

export class ReviewChangedError extends Error {
  constructor(public readonly current: { reviewText: string | null; reviewHash: string | null }) {
    super('review_changed');
    this.name = 'ReviewChangedError';
  }
}

export class ResponseChangedError extends Error {
  constructor() {
    super('response_changed');
    this.name = 'ResponseChangedError';
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Caller context — what route handlers have after requireOwnerAccess().
 * accountId: the billing parent (accounts.id).
 * locationId: the specific location being operated on (businesses.id).
 */
export interface EditContext {
  accountId: string;
  locationId: string;
}

/**
 * Tier + ownership gate. Throws on denial; resolves on permit.
 *
 * Paid-tier rule: both Copilot and Autopilot may edit gap and historical
 * replies. Any unsupported stored tier fails closed before the reply's age can
 * affect the decision; strict code never treats an unknown tier as a paid one.
 *
 * Account scope (post-migration-034): subscription_tier and
 * subscription_activated_at live on the `accounts` table (the billing parent),
 * NOT on `businesses`. We resolve them by joining businesses → accounts.
 */
export async function assertCanEditReply(
  sql: postgres.Sql,
  reviewId: string,
  ctx: EditContext,
): Promise<void> {
  const rows = await sql<{
    review_business_id: string;
    review_date: Date;
    activated_at: Date | null;
    tier: string;
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  }[]>`
    SELECT r.business_id AS review_business_id,
           r.review_date,
           a.subscription_activated_at AS activated_at,
           a.subscription_tier         AS tier,
           a.subscription_status       AS subscription_status,
           a.past_due_at               AS past_due_at,
           a.flags                     AS flags
    FROM reviews r
    JOIN businesses b ON b.id = r.business_id
    JOIN accounts  a ON a.id = b.account_id
    WHERE r.id = ${reviewId}
      AND b.account_id = ${ctx.accountId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new NotFoundError('review_not_found');

  // Ownership: the review's location must belong to the caller's account,
  // and must match the specific location the caller is scoped to.
  if (row.review_business_id !== ctx.locationId) throw new ForbiddenError();

  const writable = assertWritableSubscriptionStatus({
    subscriptionStatus: row.subscription_status,
    pastDueAt: row.past_due_at,
    accountFlags: row.flags,
  });
  if (!writable.ok) {
    throw new SubscriptionReadOnlyError(writable.error, writable.status);
  }

  if (!isSubscriptionTier(row.tier)) throw new ForbiddenError();
}

/**
 * In-tx hash + version check (spec §4.6).
 *
 * Caller MUST have already acquired
 *   SELECT FROM reviews WHERE id = $reviewId FOR UPDATE
 * inside the same transaction (otherwise the check is racy — see spec §4.6
 * "TOCTOU correctness" discussion).
 *
 * Validates against the LIVE 'posted' row (NOT the latest non-terminal),
 * because at /publish time a sibling pending_approval/edited draft would
 * naturally have version = posted.version + 1 — the check would never pass.
 */
export async function validateOptimisticConcurrency(
  tx: TxClient,
  reviewId: string,
  snapshot: { hash: string; version: number },
): Promise<void> {
  const [review] = await tx<{ review_content_hash: string | null; review_text: string | null }[]>`
    SELECT review_content_hash, review_text FROM reviews WHERE id = ${reviewId}
  `;
  if (!review) throw new NotFoundError('review_not_found');
  if (review.review_content_hash !== snapshot.hash) {
    throw new ReviewChangedError({
      reviewText: review.review_text,
      reviewHash: review.review_content_hash,
    });
  }

  const [posted] = await tx<{ version: number }[]>`
    SELECT version FROM responses
    WHERE review_id = ${reviewId} AND status = 'posted'
  `;
  if (!posted) throw new ResponseChangedError();
  if (posted.version !== snapshot.version) throw new ResponseChangedError();
}
