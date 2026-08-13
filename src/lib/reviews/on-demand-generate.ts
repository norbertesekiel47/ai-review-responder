// src/lib/reviews/on-demand-generate.ts
//
// The Generate transaction (the "On-demand generation" door, CONTEXT.md
// glossary): every in-transaction guard behind creating the FIRST draft for a
// never-replied review — the review lock, the TOCTOU writable re-check, the
// three sibling exclusions, orphan semantics, D-B version allocation, and the
// atomic outbox enqueue. Extracted from
// src/app/api/dashboard/reviews/[reviewId]/generate/route.ts (#729); the route
// stays the composition root (auth, rate limits, ownership proof, sql.begin,
// result→HTTP mapping) and callers MUST run this inside sql.begin.
//
// Invariant #3: the enqueue pins originLane = ON_DEMAND_GENERATE and
// suppressNotification = true. The Origin lane is the PRIMARY STRUCTURAL
// exclusion from isAutoApprovalCandidate — `live_ingest_new` is the only
// candidate lane, so an On-demand generation draft can never auto-post at any
// version. `suppressNotification: true` is belt-and-braces on top of it: the
// #669 audit records that worker/jobs/response-generation/persist.ts ALSO
// requires `!suppressNotification`, so this draft is excluded twice over.
// Neither is redundant — do not delete one on the theory that the other
// covers it (ticket #678).
//
// Invariant #2: the outbox row is written inside the same tx that takes the
// review lock, via enqueueGenerateResponse.

import type { TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { assertWritableSubscriptionForBusiness } from '@/lib/shared/writable-subscription';
import { POST_AFTER_DELETE_FAILED_PREFIX } from '@/lib/publishing/orphan-markers';
import { NON_TERMINAL_STATUSES } from '@/lib/shared/response-status';
import { statusArraySql } from '@/lib/shared/response-status-sql';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { enqueueGenerateResponse } from '@/lib/shared/job-outbox-helpers';
import { nextResponseVersion, pendingGenerateExists } from '@/lib/responses/generation-state';

export type OnDemandGenerateResult =
  | { ok: true; outboxId: string; version: number }
  | { ok: false; reason: 'review_not_found' }
  | { ok: false; reason: 'not_writable'; status: 402 | 403; error: string }
  | { ok: false; reason: 'already_answered' }
  | { ok: false; reason: 'draft_already_exists'; existing: { response_id: string; status: string } }
  | { ok: false; reason: 'orphan_recovery_pending' }
  | { ok: false; reason: 'regenerate_in_progress' };

export async function onDemandGenerateTx(
  tx: TransactionSql,
  args: { reviewId: string; businessId: string },
): Promise<OnDemandGenerateResult> {
  const { reviewId, businessId } = args;

  // Lock the review: two concurrent Generate clicks serialize here.
  const locked = await tx<{ id: string }[]>`
    SELECT id FROM reviews
    WHERE id = ${reviewId}::uuid AND business_id = ${businessId}::uuid
    FOR UPDATE
  `;
  if (locked.length === 0) {
    return { ok: false, reason: 'review_not_found' };
  }

  // Re-assert the writable/offboarding gate INSIDE the locked tx (TOCTOU):
  // the route's pre-tx check can go stale if an offboarding is confirmed
  // between it and this commit, and what commits here is a CHARGEABLE LLM
  // enqueue. Same shape and same reasoning as the approve/edit actions
  // (src/lib/approval/http-routes.ts) — they re-check after their locks for
  // exactly this window. Business-scoped, not account-scoped, because the
  // locked review already resolved its location.
  const writableInTx = await assertWritableSubscriptionForBusiness(businessId, tx);
  if (!writableInTx.ok) {
    return {
      ok: false,
      reason: 'not_writable',
      status: writableInTx.status,
      error: writableInTx.error,
    };
  }

  // Generate is for NEVER-REPLIED reviews only. A posted sibling means the
  // owner wants Regenerate (which replaces a live Google reply, §6.4).
  const posted = await tx<{ id: string }[]>`
    SELECT id FROM responses
    WHERE review_id = ${reviewId}::uuid
      AND business_id = ${businessId}::uuid
      AND status = 'posted'
    LIMIT 1
  `;
  if (posted.length > 0) {
    return { ok: false, reason: 'already_answered' };
  }

  const existing = await tx<{ id: string; status: string }[]>`
    SELECT id, status FROM responses
    WHERE review_id = ${reviewId}::uuid
      AND business_id = ${businessId}::uuid
      AND status = ANY(${statusArraySql(tx, NON_TERMINAL_STATUSES)})
    ORDER BY version DESC
    LIMIT 1
  `;
  if (existing[0]) {
    return {
      ok: false,
      reason: 'draft_already_exists',
      existing: { response_id: existing[0].id, status: existing[0].status },
    };
  }

  // An ORPHAN review — a `status='failed'` sibling whose posting_error
  // carries the post_after_delete_failed_ prefix, with no `posted` sibling
  // (already proven by the guard above) — is the Reviews list `recover` row
  // state, not a Generate candidate. The list never offers Generate on it,
  // but a hand-crafted same-origin POST reaches here, and the draft it
  // creates would then make past-replies/[responseId]/retry 409
  // `newer_draft_exists` — silently blocking the owner's /retry and
  // /restore-original recovery path. Offering Generate would race that path,
  // so refuse it here rather than let recovery lose the race.
  // Carries its own business_id scope (invariant #8), like every sibling read
  // in this transaction — all four are natively business-scoped at zero cost,
  // because businessId is already resolved and locked.
  const orphan = await tx<{ id: string }[]>`
    SELECT id FROM responses
    WHERE review_id = ${reviewId}::uuid
      AND business_id = ${businessId}::uuid
      AND status = 'failed'
      AND posting_error LIKE ${`${POST_AFTER_DELETE_FAILED_PREFIX}%`}
    LIMIT 1
  `;
  if (orphan.length > 0) {
    return { ok: false, reason: 'orphan_recovery_pending' };
  }

  if (await pendingGenerateExists(tx, reviewId)) {
    return { ok: false, reason: 'regenerate_in_progress' };
  }

  // D-B: MAX-derived, never hardcoded 1. A discarded draft is retained at
  // status='superseded', so version climbs and C1's per-review budget
  // self-arms on the next attempt.
  const nextVersion = await nextResponseVersion(tx, reviewId);

  const outboxId = uuidv7();
  await enqueueGenerateResponse(tx, {
    outboxId,
    reviewId,
    businessId,
    version: nextVersion,
    originLane: GENERATE_RESPONSE_ORIGIN_LANE.ON_DEMAND_GENERATE,
    suppressNotification: true,
  });

  return { ok: true, outboxId, version: nextVersion };
}
