// worker/jobs/publisher/edit-publish.ts
//
// The edit-publisher DELETE-before-POST module (spec
// `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md` §4.5 +
// §4.7; revival `2026-05-23-edit-existing-replies-revival-design.md` §3.2).
//
// When an owner edits an already-`posted` Google reply, the new reply must
// REPLACE the old one. Google has at most one live reply per review, so the
// publisher DELETEs the existing reply then POSTs the replacement. Both
// external calls run inside ONE open Postgres transaction that holds
// `reviews FOR UPDATE` + `responses FOR UPDATE` across the I/O, so a
// concurrent `processReview` content-change serializes behind us and cannot
// post stale text.
//
// External side effects cannot be rolled back: once Zernio's DELETE returns
// 200 Google's reply slot is empty and no ROLLBACK undoes that. So this
// module uses per-CATCH commit semantics — each external outcome maps to a
// specific COMMIT-or-ROLLBACK + outbox disposition (the §4.5 outcome table),
// and DELETE-success-without-POST-success leaves an orphan marker
// (`posting_error LIKE '%_after_delete_succeeded'`) so the failed-hook
// (Task 7) and `/retry` (Task 11) can recover.
//
// This module does NOT decide WHEN it runs — the worker dispatcher (Task 6)
// calls it when (a sibling `posted` row exists OR the candidate carries an
// orphan marker) AND `EDIT_REPLIES_ENABLED === 'true'`. In every other case
// the dispatcher uses today's POST-only `post-reply` path. Phase A here is a
// non-locking pre-flight that returns `continue_to_fresh` when neither
// condition holds under a fresh read, so a misroute degrades safely.

import * as Sentry from '@sentry/node';
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { jsonb, sql } from '../../../src/lib/db/server';
import { zernioClient as defaultZernioClient } from '../../../src/lib/zernio/client';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyDeletedError,
  ZernioReplyAlreadyExistsError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
  redactSensitiveError,
  verify409InTx as defaultVerify409InTx,
  type Verify409Disposition,
} from './publisher-error-handlers';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { SendOwnerEmailPayload } from '../../../src/lib/shared/worker-types';
import {
  PENDING_AFTER_DELETE,
  ZERNIO_AUTH_ERROR,
  ZERNIO_AUTH_ERROR_AFTER_DELETE,
  deleteFailedMarker,
  isOrphanMarker,
  postAfterDeleteFailedMarker,
} from './orphan-markers';

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
  zernioClient?: Pick<typeof defaultZernioClient, 'deleteReply' | 'postReply'>;
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
  | { outcome: 'completed' }
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

function permanentErrorKind(err: ZernioPermanentError | ZernioValidationError): string {
  return err instanceof ZernioPermanentError ? err.kind ?? 'unknown' : 'validation';
}

export async function runEditPublishIfApplicable(
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
  const zernioClient = deps.zernioClient ?? defaultZernioClient;
  const verify409InTx = deps.verify409InTx ?? defaultVerify409InTx;

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
    | { kind: 'continue_to_fresh' }
    | { kind: 'idempotent_completed' }
    | { kind: 'review_id_drift' }
    | { kind: 'orphan_response_review' }
    | { kind: 'success' }
    | { kind: 'auth_completed' }
    | { kind: '409_matches' }
    | { kind: '409_mismatch_after_delete' }
    | { kind: '409_mismatch_no_delete' }
    | { kind: 'permanent_failed' }
    | { kind: 'commit_then_throw'; error: Error }
    | { kind: 'rollback_then_throw'; error: Error };

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
          await zernioClient.deleteReply(zernioAccountId, zernioReviewId);
          deleteSucceeded = true;
        } catch (err) {
          if (isDeleteAlreadyGone(err)) {
            // 404 → reply already gone. Treat as DELETE success; proceed to POST.
            deleteSucceeded = true;
          } else if (err instanceof ZernioAuthError) {
            // True 401/403 on DELETE. Sibling UNCHANGED (DELETE did not
            // succeed externally — the old reply is still on Google). Plain
            // 'zernio_auth_error' (no orphan suffix).
            await applyAuthErrorTerminalInTx(tx, {
              responseId,
              businessId,
              accountId: zernioAccountId,
              locationId: zernioLocationId,
              errorBody: err.body ? String(err.body).slice(0, 500) : err.message,
              postDeleteCommitted: false,
              existingPosted: null,
              logger,
            });
            outcomeRef.value = { kind: 'auth_completed' };
            return;
          } else if (err instanceof ZernioTransientError) {
            // DELETE did not succeed → nothing externally committed. Throw to
            // ROLLBACK and let BullMQ retry.
            const wrapped = new PublisherTransientWithContext(err, {
              response_id: responseId,
              business_id: businessId,
              account_id: zernioAccountId,
              location_id: zernioLocationId,
            });
            outcomeRef.value = { kind: 'rollback_then_throw', error: wrapped };
            throw wrapped;
          } else if (err instanceof ZernioPermanentError) {
            // DELETE permanent failure (incl. inbox_addon_required). Sibling
            // UNCHANGED — the old reply is still on Google.
            const kind = err.kind ?? 'unknown';
            const updated = await tx`
              UPDATE responses
              SET status = 'failed',
                  posting_error = ${deleteFailedMarker(kind)},
                  updated_at = NOW()
              WHERE id = ${responseId}
                AND business_id = ${businessId}
                AND status IN ('approved', 'edited', 'awaiting_owner_connect')
              RETURNING 1
            `;
            if (updated.count !== 1) {
              throw new Error(
                `delete-permanent: candidate UPDATE expected 1 row, got ${updated.count}`,
              );
            }
            outcomeRef.value = { kind: 'permanent_failed' };
            return;
          } else {
            // Programming bug / unknown error → bubble to the outer catch.
            throw err;
          }
        }
      }

      // After this point postDeleteCommitted == true if a DELETE happened
      // (including the 404-as-success case) OR this is an orphan retry (a
      // prior attempt already emptied Google's slot).
      const postDeleteCommitted = deleteSucceeded || lockedIsOrphanRetry;

      // 6. POST branch.
      try {
        await zernioClient.postReply(zernioAccountId, zernioReviewId, {
          comment: approvedText,
        });
      } catch (err) {
        if (err instanceof ZernioReplyAlreadyExistsError) {
          const disp = await verify409InTx({
            tx,
            account_id: zernioAccountId,
            location_id: zernioLocationId,
            zernio_review_id: zernioReviewId,
            approved_text: approvedText,
            logger,
          });
          outcomeRef.value = await handle409Disposition(tx, disp, {
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
          });
          // The indeterminate / transient sub-cases that committed a sibling
          // supersede return `commit_then_throw`; the no-external-commit cases
          // throw inside handle409Disposition to force ROLLBACK.
          return;
        }

        if (err instanceof ZernioAuthError) {
          await applyAuthErrorTerminalInTx(tx, {
            responseId,
            businessId,
            accountId: zernioAccountId,
            locationId: zernioLocationId,
            errorBody: err.body ? String(err.body).slice(0, 500) : err.message,
            postDeleteCommitted,
            existingPosted: postDeleteCommitted && existingPosted ? { id: existingPosted.id } : null,
            logger,
          });
          outcomeRef.value = { kind: 'auth_completed' };
          return;
        }

        if (err instanceof ZernioTransientError) {
          if (postDeleteCommitted && existingPosted) {
            // DELETE succeeded externally — commit the sibling supersede AND
            // set the orphan marker so the retry's no-DELETE path keeps
            // post-DELETE-success semantics.
            await supersedeSibling(tx, existingPosted.id);
            await setOrphanMarker(tx, responseId, businessId);
            const wrapped = new PublisherTransientWithContext(err, {
              response_id: responseId,
              business_id: businessId,
              account_id: zernioAccountId,
              location_id: zernioLocationId,
            });
            outcomeRef.value = { kind: 'commit_then_throw', error: wrapped };
            return;
          }
          if (lockedIsOrphanRetry) {
            // Already orphan; posting_error stays. Commit (nothing changed) + retry.
            const wrapped = new PublisherTransientWithContext(err, {
              response_id: responseId,
              business_id: businessId,
              account_id: zernioAccountId,
              location_id: zernioLocationId,
            });
            outcomeRef.value = { kind: 'commit_then_throw', error: wrapped };
            return;
          }
          // No external commit (no DELETE, no POST) → ROLLBACK + retry.
          const wrapped = new PublisherTransientWithContext(err, {
            response_id: responseId,
            business_id: businessId,
            account_id: zernioAccountId,
            location_id: zernioLocationId,
          });
          outcomeRef.value = { kind: 'rollback_then_throw', error: wrapped };
          throw wrapped;
        }

        if (err instanceof ZernioPermanentError || err instanceof ZernioValidationError) {
          await markCandidatePermanentFailedInTx(tx, {
            responseId,
            businessId,
            postDeleteCommitted,
            existingPosted,
            kind: permanentErrorKind(err),
          });
          outcomeRef.value = { kind: 'permanent_failed' };
          return;
        }

        // Unknown error — bubble.
        throw err;
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
    case '409_matches':
    case 'success':
      return { outcome: 'completed' };
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

// ── 409 disposition handling ─────────────────────────────────────────────

interface Handle409Args {
  responseId: string;
  businessId: string;
  reviewId: string;
  approvedText: string;
  zernioAccountId: string;
  zernioLocationId: string;
  zernioReviewId: string;
  existingPosted: { id: string } | undefined;
  postDeleteCommitted: boolean;
  lockedIsOrphanRetry: boolean;
  logger: WorkerLogger;
}

type Tx409Outcome =
  | { kind: '409_matches' }
  | { kind: '409_mismatch_after_delete' }
  | { kind: '409_mismatch_no_delete' }
  | { kind: 'permanent_failed' }
  | { kind: 'auth_completed' }
  | { kind: 'commit_then_throw'; error: Error };

/**
 * Apply the §4.5 per-disposition commit semantics for a POST 409. Throws
 * (forcing ROLLBACK) only on the indeterminate/transient sub-cases where
 * nothing was externally committed; otherwise records a commit outcome.
 */
async function handle409Disposition(
  tx: postgres.TransactionSql,
  disp: Verify409Disposition,
  args: Handle409Args,
): Promise<Tx409Outcome> {
  const {
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
  } = args;

  if (disp.disposition === 'matches_our_text') {
    // Our reply IS on Google. Sibling supersede + candidate posted + clear marker.
    if (existingPosted) {
      await supersedeSibling(tx, existingPosted.id);
    }
    const succ = await tx`
      UPDATE responses
      SET status = 'posted', posted_at = NOW(),
          posting_error = NULL, updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (succ.count !== 1) {
      throw new Error('candidate_lost_during_publish');
    }
    return { kind: '409_matches' };
  }

  if (disp.disposition === 'mismatch') {
    if (postDeleteCommitted) {
      // DELETE happened — the old reply is GONE. Whatever mismatching text is
      // on Google now is third-party. Sibling → superseded (truth). Candidate
      // → superseded. Open an exception for admin reconciliation.
      if (existingPosted) {
        await supersedeSibling(tx, existingPosted.id);
      }
      const upd = await tx`
        UPDATE responses
        SET status = 'superseded', updated_at = NOW()
        WHERE id = ${responseId}
          AND business_id = ${businessId}
          AND status IN ('approved', 'edited', 'awaiting_owner_connect')
        RETURNING 1
      `;
      if (upd.count !== 1) {
        throw new Error('candidate_lost_during_publish');
      }
      await tx`
        INSERT INTO review_exceptions (
          id, business_id, review_id, response_id, type, payload
        ) VALUES (
          ${uuidv7()}, ${businessId}, ${reviewId}, ${responseId},
          'edit_publish_409_mismatch_after_delete',
          ${jsonb({ verifier_text: disp.verifierText, expected_text: approvedText })}
        )
        ON CONFLICT (review_id, type) WHERE status = 'open'
        DO UPDATE SET payload = review_exceptions.payload
      `;
      return { kind: '409_mismatch_after_delete' };
    }
    // No DELETE happened → today's verify-first supersede semantics.
    const upd = await tx`
      UPDATE responses
      SET status = 'superseded', updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (upd.count !== 1) {
      throw new Error('candidate_lost_during_publish');
    }
    return { kind: '409_mismatch_no_delete' };
  }

  if (disp.disposition === 'indeterminate') {
    if (postDeleteCommitted && existingPosted) {
      // DELETE happened, sibling supersede MUST commit. Set the orphan marker
      // so the retry's no-DELETE path keeps post-DELETE semantics.
      await supersedeSibling(tx, existingPosted.id);
      await setOrphanMarker(tx, responseId, businessId);
      return {
        kind: 'commit_then_throw',
        error: indeterminateError(disp, args),
      };
    }
    if (lockedIsOrphanRetry) {
      // Already orphan; just retry (posting_error stays). Commit nothing new.
      return {
        kind: 'commit_then_throw',
        error: indeterminateError(disp, args),
      };
    }
    // No external commit (no DELETE, no successful POST) → ROLLBACK + retry.
    throw indeterminateError(disp, args);
  }

  if (disp.disposition === 'auth') {
    await applyAuthErrorTerminalInTx(tx, {
      responseId,
      businessId,
      accountId: zernioAccountId,
      locationId: zernioLocationId,
      errorBody: disp.lookupErr.body
        ? String(disp.lookupErr.body).slice(0, 500)
        : disp.lookupErr.message,
      postDeleteCommitted,
      existingPosted: postDeleteCommitted && existingPosted ? { id: existingPosted.id } : null,
      logger,
    });
    return { kind: 'auth_completed' };
  }

  if (disp.disposition === 'permanent') {
    await markCandidatePermanentFailedInTx(tx, {
      responseId,
      businessId,
      postDeleteCommitted,
      existingPosted,
      kind: permanentErrorKind(disp.lookupErr),
    });
    return { kind: 'permanent_failed' };
  }

  // disp.disposition === 'transient'
  if (postDeleteCommitted && existingPosted) {
    await supersedeSibling(tx, existingPosted.id);
    await setOrphanMarker(tx, responseId, businessId);
    return {
      kind: 'commit_then_throw',
      error: new PublisherTransientWithContext(disp.lookupErr, {
        response_id: responseId,
        business_id: businessId,
        account_id: zernioAccountId,
        location_id: zernioLocationId,
      }),
    };
  }
  if (lockedIsOrphanRetry) {
    return {
      kind: 'commit_then_throw',
      error: new PublisherTransientWithContext(disp.lookupErr, {
        response_id: responseId,
        business_id: businessId,
        account_id: zernioAccountId,
        location_id: zernioLocationId,
      }),
    };
  }
  throw new PublisherTransientWithContext(disp.lookupErr, {
    response_id: responseId,
    business_id: businessId,
    account_id: zernioAccountId,
    location_id: zernioLocationId,
  });
}

function indeterminateError(
  disp: Extract<Verify409Disposition, { disposition: 'indeterminate' }>,
  args: Handle409Args,
): ZernioReplyVerificationIndeterminateError {
  return new ZernioReplyVerificationIndeterminateError({
    response_id: args.responseId,
    business_id: args.businessId,
    review_id: args.reviewId,
    account_id: args.zernioAccountId,
    location_id: args.zernioLocationId,
    zernio_review_id: args.zernioReviewId,
    reason: disp.reason,
    ...disp.meta,
  });
}

// ── Shared in-tx mutation helpers ─────────────────────────────────────────

async function supersedeSibling(tx: postgres.TransactionSql, siblingId: string): Promise<void> {
  const sup = await tx`
    UPDATE responses SET status = 'superseded', updated_at = NOW()
    WHERE id = ${siblingId} AND status = 'posted'
    RETURNING 1
  `;
  if (sup.count !== 1) {
    throw new Error('sibling_lost_during_publish');
  }
}

async function setOrphanMarker(
  tx: postgres.TransactionSql,
  responseId: string,
  businessId: string,
): Promise<void> {
  const cand = await tx`
    UPDATE responses
    SET posting_error = ${PENDING_AFTER_DELETE}, updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    RETURNING 1
  `;
  if (cand.count !== 1) {
    throw new Error('candidate_lost_during_publish');
  }
}

/**
 * Permanent-failure terminal for the candidate. Shared by the POST-catch
 * permanent branch and the 409 `permanent` disposition branch. When DELETE has
 * already committed, supersede the sibling (orphan forming) and write the
 * `post_after_delete_failed_*` marker so /retry + /restore-original recognize
 * the row; otherwise it's a fresh-publish-style permanent failure with a bare
 * `${kind}` marker.
 */
async function markCandidatePermanentFailedInTx(
  tx: postgres.TransactionSql,
  args: {
    responseId: string;
    businessId: string;
    postDeleteCommitted: boolean;
    existingPosted: { id: string } | undefined;
    kind: string;
  },
): Promise<void> {
  const { responseId, businessId, postDeleteCommitted, existingPosted, kind } = args;
  const postingError = postDeleteCommitted ? postAfterDeleteFailedMarker(kind) : kind;
  if (postDeleteCommitted && existingPosted) {
    await supersedeSibling(tx, existingPosted.id);
  }
  const upd = await tx`
    UPDATE responses
    SET status = 'failed',
        posting_error = ${postingError},
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    RETURNING 1
  `;
  if (upd.count !== 1) {
    throw new Error('candidate_lost_during_publish');
  }
}

/**
 * In-tx auth-terminal sequence for the edit-publisher branch. Mirrors
 * `handlePublisherAuthErrorTerminal` (which opens its OWN sql.begin and would
 * self-deadlock if called from inside our tx). Differences:
 *   - Operates on the open `tx` so reads/writes share our locks.
 *   - Does NOT call markOutboxCompleted (the dispatcher owns the outbox).
 *   - Picks posting_error based on postDeleteCommitted so the orphan marker
 *     survives drain re-enqueue (§4.5):
 *       postDeleteCommitted=false → 'zernio_auth_error'
 *       postDeleteCommitted=true  → 'zernio_auth_error_after_delete_succeeded'
 *   - Optionally supersedes the sibling 'posted' row (post-DELETE-success only).
 */
async function applyAuthErrorTerminalInTx(
  tx: postgres.TransactionSql,
  args: {
    responseId: string;
    businessId: string;
    accountId: string;
    locationId: string;
    errorBody: string;
    postDeleteCommitted: boolean;
    existingPosted: { id: string } | null;
    logger: WorkerLogger;
  },
): Promise<void> {
  const {
    responseId,
    businessId,
    accountId,
    locationId,
    errorBody,
    postDeleteCommitted,
    existingPosted,
    logger,
  } = args;

  const safeBody = redactSensitiveError(errorBody);

  const disconnected = await tx`
    UPDATE zernio_connections
    SET status = 'disconnected',
        disconnected_at = NOW(),
        disconnect_reason = 'auth_error_on_publish',
        last_error = ${safeBody},
        last_error_at = NOW(),
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND zernio_account_id = ${accountId}
      AND zernio_location_id = ${locationId}
      AND status = 'active'
    RETURNING 1
  `;

  if (postDeleteCommitted && existingPosted) {
    await supersedeSibling(tx, existingPosted.id);
  }

  const postingError = postDeleteCommitted
    ? ZERNIO_AUTH_ERROR_AFTER_DELETE
    : ZERNIO_AUTH_ERROR;
  const parked = await tx<{ review_id: string }[]>`
    UPDATE responses
    SET status = 'awaiting_owner_connect',
        posting_error = ${postingError},
        updated_at = NOW()
    WHERE id = ${responseId}
      AND business_id = ${businessId}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
    RETURNING review_id
  `;

  if (parked.length === 0) {
    logger.warn(`Response ${responseId} already terminal — skipping reconnect notify`);
    return;
  }

  const reconnectPayload = {
    kind: 'reconnect_required',
    response_id: responseId,
    business_id: businessId,
  } satisfies SendOwnerEmailPayload;
  await tx`
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
    ) VALUES (
      ${uuidv7()}, 'notify_owner_reconnect', 'response', ${responseId},
      ${jsonb(reconnectPayload)}, 0, 5
    )
  `;

  if (disconnected.count > 0) {
    const lostPayload = {
      kind: 'connection_lost',
      business_id: businessId,
    } satisfies SendOwnerEmailPayload;
    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()}, 'notify_owner_connection_lost', 'business', ${businessId},
        ${jsonb(lostPayload)}, 0, 5
      )
    `;
  }
}
