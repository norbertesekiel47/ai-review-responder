// worker/jobs/publisher/edit-publish-errors.ts
//
// Error-disposition policy for the edit-publisher DELETE-before-POST flow
// (spec §4.5 outcome table). Given an error from the external DELETE/POST call,
// decides the per-CATCH commit semantics: which rows to mutate (via the -tx
// helpers) and which outcome to hand back to the orchestrator. Imports the
// -tx leaf; never imports edit-publish.ts (keeps the graph acyclic).

import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { jsonb } from '../../../src/lib/db/server';
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
  type Verify409Disposition,
} from './publisher-error-handlers';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import {
  applyAuthErrorTerminalInTx,
  markCandidatePermanentFailedInTx,
  setOrphanMarker,
  supersedeSibling,
} from './edit-publish-tx';
import { deleteFailedMarker } from './orphan-markers';

export interface EditPublishCatchArgs {
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

export type Tx409Outcome =
  | { kind: '409_matches' }
  | { kind: '409_mismatch_after_delete' }
  | { kind: '409_mismatch_no_delete' }
  | { kind: 'permanent_failed' }
  | { kind: 'auth_completed' }
  | { kind: 'commit_then_throw'; error: Error };

/** Every outcome a DELETE/POST catch handler can produce. Extends Tx409Outcome with rollback_then_throw. */
export type TxCatchOutcome =
  | { kind: 'auth_completed' }
  | { kind: 'permanent_failed' }
  | { kind: '409_matches' }
  | { kind: '409_mismatch_after_delete' }
  | { kind: '409_mismatch_no_delete' }
  | { kind: 'commit_then_throw'; error: Error }
  | { kind: 'rollback_then_throw'; error: Error };

export function permanentErrorKind(
  err: ZernioPermanentError | ZernioValidationError,
): string {
  return err instanceof ZernioPermanentError ? err.kind ?? 'unknown' : 'validation';
}

/**
 * Apply the §4.5 per-disposition commit semantics for a POST 409. Throws
 * (forcing ROLLBACK) only on the indeterminate/transient sub-cases where
 * nothing was externally committed; otherwise records a commit outcome.
 */
export async function handle409Disposition(
  tx: postgres.TransactionSql,
  disp: Verify409Disposition,
  args: EditPublishCatchArgs,
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
  args: EditPublishCatchArgs,
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

export interface DeleteErrorArgs {
  responseId: string;
  businessId: string;
  zernioAccountId: string;
  zernioLocationId: string;
  logger: WorkerLogger;
}

/**
 * Disposition for an error thrown by the DELETE call. The orchestrator handles
 * the 404-as-success case (isDeleteAlreadyGone) inline BEFORE calling this, so
 * here the DELETE genuinely failed and the sibling 'posted' row is UNCHANGED on
 * Google. Returns the outcome the orchestrator records; programming/unknown
 * errors are re-thrown to bubble to the outer catch.
 */
export async function handleDeleteError(
  tx: postgres.TransactionSql,
  err: unknown,
  args: DeleteErrorArgs,
): Promise<TxCatchOutcome> {
  const { responseId, businessId, zernioAccountId, zernioLocationId, logger } = args;

  if (err instanceof ZernioAuthError) {
    // True 401/403 on DELETE. DELETE did not succeed externally — plain
    // 'zernio_auth_error' (no orphan suffix), sibling untouched.
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
    return { kind: 'auth_completed' };
  }

  if (err instanceof ZernioTransientError) {
    // Nothing externally committed → orchestrator throws to ROLLBACK + retry.
    return {
      kind: 'rollback_then_throw',
      error: new PublisherTransientWithContext(err, {
        response_id: responseId,
        business_id: businessId,
        account_id: zernioAccountId,
        location_id: zernioLocationId,
      }),
    };
  }

  if (err instanceof ZernioPermanentError) {
    // DELETE permanent failure (incl. inbox_addon_required). Sibling unchanged.
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
    return { kind: 'permanent_failed' };
  }

  // Programming bug / unknown error → bubble to the outer catch.
  throw err;
}
