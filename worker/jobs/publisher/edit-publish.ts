// worker/jobs/publisher/edit-publish.ts
//
// Orchestrator for the DELETE-before-POST edit-publisher flow (spec
// `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md` §4.5 +
// §4.7; revival `2026-05-23-edit-existing-replies-revival-design.md` §3.2).
//
// Error disposition (per-CATCH §4.5 commit semantics) lives in
// `./edit-publish-errors`; the in-tx row mutations live in `./edit-publish-tx`.
//
// High-level structure:
//   Phase A — non-locking pre-flight (no tx, no DELETE). Cheaply decides
//             whether this is an edit (sibling 'posted' exists OR orphan
//             marker). Returns `continue_to_fresh` immediately if neither.
//   Phase B — single open Postgres tx holding `reviews FOR UPDATE` +
//             `responses FOR UPDATE` across both external calls (DELETE then
//             POST), so concurrent `processReview` content-changes serialize
//             behind us. All in-tx row mutations are delegated to -tx helpers.
//   Dispatch — the dispatcher owns the outbox lifecycle; this module returns
//              an `EditPublishOutcome` for every committed tx path so the
//              dispatcher calls `markOutboxCompleted/Failed/throw` in one place
//              (per-CATCH §4.5 outcome table). A thrown 'rollback_then_throw'
//              is re-surfaced from the catch and delivered as `outcome:'throw'`.

import * as Sentry from '@sentry/node';
import type { Sql } from 'postgres';
import { getReviewPublisher } from '../../../src/lib/publishing/review-publisher';
import type { ReviewLocator, ReviewPublisher } from '../../../src/lib/publishing/review-publisher';
import {
  ZernioPermanentError,
  ZernioReplyAlreadyDeletedError,
} from '../../../src/lib/zernio/errors';
import { verify409InTx as defaultVerify409InTx } from './publisher-error-handlers';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { PostedResponseActivationInput } from './activation';
import { isOrphanMarker } from '../../../src/lib/publishing/orphan-markers';
import {
  handleDeleteError,
  handlePostError,
  type TxCatchOutcome,
} from './edit-publish-errors';
import { supersedeSibling } from './edit-publish-tx';

/** Context the dispatcher (Task 6) materializes before calling this module. */
export interface EditPublishContext {
  responseId: string;
  businessId: string;
  reviewId: string;
  approvedText: string;
  /** The candidate row's `posting_error` (orphan-marker detection). */
  responsePostingError: string | null;
  zernioAccountId: string;
  zernioLocationId: string;
  zernioReviewId: string;
  correlationId: string | undefined;
  logger: WorkerLogger;
}

/** Injectable dependencies — real defaults; tests/Task 6 override. */
export interface EditPublishDeps {
  publisher?: Pick<ReviewPublisher, 'deleteReply' | 'publishReply'>;
  verify409InTx?: typeof defaultVerify409InTx;
}

/**
 * Outcome the dispatcher acts on. This module owns all DB mutations and the
 * per-CATCH commit decisions; the dispatcher owns the outbox lifecycle and
 * the `throw` (so BullMQ retries), keeping the orphan-marker semantics easy
 * to audit against the §4.5 outcome table.
 *
 * - `completed`: terminal; dispatcher calls `markOutboxCompleted`.
 * - `failed`: terminal failure; dispatcher calls `markOutboxFailed(reason)`.
 * - `throw`: dispatcher re-throws so BullMQ retries (transient / indeterminate).
 * - `continue_to_fresh`: not an edit (no sibling, no marker); dispatcher runs
 *   today's POST-only fresh-publish path. NO external I/O happened.
 */
export type EditPublishOutcome =
  | { outcome: 'completed'; postedResponse?: PostedResponseActivationInput }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'throw'; error: unknown }
  | { outcome: 'continue_to_fresh' };

/**
 * A DELETE 404 means the old reply was already gone on Google (race with
 * another flow, or the owner deleted it via the Google Business dashboard
 * directly). Treat it as DELETE success — the slot is empty regardless of who
 * emptied it — and proceed to POST.
 *
 * TRACKED GAP (Task 1): the Zernio error classifier does NOT currently throw
 * `ZernioReplyAlreadyDeletedError` for a delete 404 — `reviewId` isn't in the
 * classifier's scope, so a delete 404 falls through to the generic 4xx branch
 * as `ZernioPermanentError('http_404', { endpointKind: 'delete_reply' })`.
 * Rather than widen `classifyAndParse`'s signature to thread `reviewId`
 * through every call site (high blast radius), we detect both shapes HERE:
 * the forward-compatible `ZernioReplyAlreadyDeletedError`, AND the
 * `ZernioPermanentError` http_404/delete_reply pair the classifier emits
 * today. Either is DELETE success.
 */
function isDeleteAlreadyGone(err: unknown): boolean {
  if (err instanceof ZernioReplyAlreadyDeletedError) return true;
  return (
    err instanceof ZernioPermanentError &&
    err.kind === 'http_404' &&
    (err.meta as { endpointKind?: unknown })?.endpointKind === 'delete_reply'
  );
}

function postedResponseActivationInput(args: {
  responseId: string;
  businessId: string;
  reviewId: string;
  logger: WorkerLogger;
}): PostedResponseActivationInput {
  return {
    responseId: args.responseId,
    businessId: args.businessId,
    reviewId: args.reviewId,
    logger: args.logger,
  };
}

export async function runEditPublishIfApplicable(
  sql: Sql,
  context: EditPublishContext,
  deps: EditPublishDeps = {},
): Promise<EditPublishOutcome> {
  const {
    responseId,
    businessId,
    reviewId,
    approvedText,
    responsePostingError,
    zernioAccountId,
    zernioLocationId,
    zernioReviewId,
    logger,
  } = context;
  const publisher = deps.publisher ?? getReviewPublisher(sql);
  const verify409InTx = deps.verify409InTx ?? defaultVerify409InTx;
  const locator: ReviewLocator = {
    accountId: zernioAccountId,
    locationId: zernioLocationId,
    providerReviewId: zernioReviewId,
  };

  // ── PHASE A: Non-locking pre-flight (no tx, no DELETE) ────────────────
  //
  // Decide whether this is an edit (sibling 'posted' exists OR the candidate
  // carries an orphan marker) cheaply, WITHOUT paying the ~30s lock-window
  // cost on true fresh publishes. review_id is immutable on a response row;
  // posting_error CAN change between this read and the locked re-read, but
  // Phase B re-validates everything under the lock — Phase A is just a
  // fast-path filter that degrades to `continue_to_fresh` if it guesses wrong.
  const phaseAIsOrphanRetry = isOrphanMarker(responsePostingError);

  const [existingPostedProbe] = await sql<{ id: string }[]>`
    SELECT id FROM responses
    WHERE review_id = ${reviewId}
      AND business_id = ${businessId}
      AND status = 'posted'
      AND id != ${responseId}
    LIMIT 1
  `;

  if (!existingPostedProbe && !phaseAIsOrphanRetry) {
    return { outcome: 'continue_to_fresh' };
  }

  // ── PHASE B: Locked edit-publisher tx ──────────────────────────────────
  //
  // The begin-callback either RETURNS normally (commit) and records the
  // outcome in `outcomeRef`, OR THROWS (rollback) for the cases where nothing
  // was externally committed. We read `outcomeRef` after commit to dispatch;
  // a thrown 'rollback_then_throw' is re-surfaced from the catch.

  type TxOutcome =
    | TxCatchOutcome
    | { kind: 'continue_to_fresh' }
    | { kind: 'idempotent_completed' }
    | { kind: 'review_id_drift' }
    | { kind: 'orphan_response_review' }
    | { kind: 'success' };

  // Single-field box so the closure mutation narrows across `await sql.begin`
  // (a bare `let x: T | null = null` gets pinned to `null` by TS narrowing).
  const outcomeRef: { value: TxOutcome | null } = { value: null };

  try {
    await sql.begin(async (tx) => {
      // 1. Lock review FIRST — canonical order with processReview
      //    (process-review.ts acquires `reviews FOR UPDATE` first). Locking
      //    the response first would risk a deadlock against processReview.
      const [reviewLock] = await tx<{ id: string }[]>`
        SELECT id FROM reviews
        WHERE id = ${reviewId} AND business_id = ${businessId}
        FOR UPDATE
      `;
      if (!reviewLock) {
        Sentry.captureMessage('publish_orphan_response_review', {
          extra: { response_id: responseId, business_id: businessId, review_id: reviewId },
        });
        outcomeRef.value = { kind: 'orphan_response_review' };
        return;
      }

      // 2. Lock the candidate response with a publishable-status guard.
      const [lockedResp] = await tx<{
        id: string;
        status: string;
        approved_text: string | null;
        posting_error: string | null;
        review_id: string;
      }[]>`
        SELECT id, status, approved_text, posting_error, review_id
        FROM responses
        WHERE id = ${responseId}
          AND status IN ('approved', 'edited', 'awaiting_owner_connect')
          AND business_id = ${businessId}
        FOR UPDATE
      `;
      if (!lockedResp) {
        // Row moved out of publishable state between Phase A and now (e.g.
        // processReview supersede). Idempotent exit — no external calls.
        outcomeRef.value = { kind: 'idempotent_completed' };
        return;
      }
      if (lockedResp.review_id !== reviewId) {
        // review_id is immutable; this is impossible. Defense in depth.
        Sentry.captureMessage('publish_review_id_drift', {
          extra: {
            response_id: responseId,
            business_id: businessId,
            expected: reviewId,
            actual: lockedResp.review_id,
          },
        });
        outcomeRef.value = { kind: 'review_id_drift' };
        return;
      }

      const lockedIsOrphanRetry = isOrphanMarker(lockedResp.posting_error);

      // 3. Existing-posted detection under lock.
      const [existingPosted] = await tx<{ id: string }[]>`
        SELECT id FROM responses
        WHERE review_id = ${reviewId}
          AND status = 'posted'
          AND id != ${responseId}
        LIMIT 1
        FOR UPDATE
      `;

      // 4. Re-validate the branch decision under lock. If the sibling vanished
      //    AND no orphan marker, we shouldn't be in the edit branch — release
      //    locks (trivial commit) and let the dispatcher run fresh-publish.
      if (!existingPosted && !lockedIsOrphanRetry) {
        outcomeRef.value = { kind: 'continue_to_fresh' };
        return;
      }

      // 5. DELETE branch — only if a sibling 'posted' currently exists. An
      //    orphan retry has no sibling (it was superseded by a prior attempt)
      //    and skips DELETE entirely.
      let deleteSucceeded = false;
      if (existingPosted) {
        try {
          await publisher.deleteReply(locator);
          deleteSucceeded = true;
        } catch (err) {
          if (isDeleteAlreadyGone(err)) {
            // 404 → reply already gone. Treat as DELETE success; proceed to POST.
            deleteSucceeded = true;
          } else {
            const outcome = await handleDeleteError(tx, err, {
              responseId,
              businessId,
              zernioAccountId,
              zernioLocationId,
              logger,
            });
            outcomeRef.value = outcome;
            if (outcome.kind === 'rollback_then_throw') throw outcome.error;
            return;
          }
        }
      }

      // After this point postDeleteCommitted == true if a DELETE happened
      // (including the 404-as-success case) OR this is an orphan retry (a
      // prior attempt already emptied Google's slot).
      const postDeleteCommitted = deleteSucceeded || lockedIsOrphanRetry;

      // 6. POST branch.
      try {
        await publisher.publishReply(locator, approvedText);
      } catch (err) {
        const outcome = await handlePostError(
          sql,
          tx,
          err,
          {
            responseId,
            businessId,
            reviewId,
            approvedText,
            zernioAccountId,
            zernioLocationId,
            zernioReviewId,
            existingPosted,
            postDeleteCommitted,
            lockedIsOrphanRetry,
            logger,
          },
          verify409InTx,
        );
        outcomeRef.value = outcome;
        if (outcome.kind === 'rollback_then_throw') throw outcome.error;
        return;
      }

      // 7. Success path. Sibling supersede + candidate posted + clear marker.
      if (existingPosted) {
        await supersedeSibling(tx, existingPosted.id);
      }
      const succ = await tx`
        UPDATE responses
        SET status = 'posted',
            posted_at = NOW(),
            posting_error = NULL,
            updated_at = NOW()
        WHERE id = ${responseId}
          AND business_id = ${businessId}
          AND status IN ('approved', 'edited', 'awaiting_owner_connect')
        RETURNING 1
      `;
      if (succ.count !== 1) {
        throw new Error('candidate_lost_during_publish');
      }
      outcomeRef.value = { kind: 'success' };
    });
  } catch (err) {
    // Tx threw → rollback already happened. If we recorded a deliberate
    // rollback-then-throw, re-throw the captured error. Otherwise the throw
    // came from an affected-row assertion or a programming bug; bubble it.
    const captured = outcomeRef.value;
    if (captured && captured.kind === 'rollback_then_throw') {
      return { outcome: 'throw', error: captured.error };
    }
    return { outcome: 'throw', error: err };
  }

  // Tx committed → dispatch on the recorded outcome.
  if (!outcomeRef.value) {
    throw new Error('edit-publish tx committed without setting outcomeRef.value');
  }
  const outcome = outcomeRef.value;
  switch (outcome.kind) {
    case 'continue_to_fresh':
      return { outcome: 'continue_to_fresh' };
    case 'idempotent_completed':
    case 'auth_completed':
      return { outcome: 'completed' };
    case '409_matches':
    case 'success':
      return {
        outcome: 'completed',
        postedResponse: postedResponseActivationInput({ responseId, businessId, reviewId, logger }),
      };
    case 'review_id_drift':
      return { outcome: 'failed', reason: 'publish_review_id_drift' };
    case 'orphan_response_review':
      return { outcome: 'failed', reason: 'publish_orphan_response_review' };
    case 'permanent_failed':
      return { outcome: 'failed', reason: 'zernio_permanent_after_edit_publish' };
    case '409_mismatch_after_delete':
      return { outcome: 'failed', reason: 'edit_publish_409_mismatch_after_delete' };
    case '409_mismatch_no_delete':
      return { outcome: 'failed', reason: 'already_replied_external' };
    case 'commit_then_throw':
      return { outcome: 'throw', error: outcome.error };
    case 'rollback_then_throw':
      // Unreachable here (we'd have hit the catch above); defensive.
      return { outcome: 'throw', error: outcome.error };
  }
}
