// worker/jobs/publisher/edit-publish-tx.ts
//
// L1 in-tx row mutations for the edit-publisher DELETE-before-POST flow
// (spec docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.5).
// Each helper runs on an already-open transaction (the tx handle), enforces the
// publishable-status guard, and asserts the affected-row count so a lost row
// fails loudly. Leaf module: no imports from edit-publish.ts / -errors.ts.

import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { redactSensitiveError } from './publisher-error-handlers';
import {
  PENDING_AFTER_DELETE,
  ZERNIO_AUTH_ERROR,
  ZERNIO_AUTH_ERROR_AFTER_DELETE,
  postAfterDeleteFailedMarker,
} from '../../../src/lib/publishing/orphan-markers';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { SendOwnerEmailPayload } from '../../../src/lib/shared/worker-types';

export async function supersedeSibling(tx: postgres.TransactionSql, siblingId: string): Promise<void> {
  const sup = await tx`
    UPDATE responses SET status = 'superseded', updated_at = NOW()
    WHERE id = ${siblingId} AND status = 'posted'
    RETURNING 1
  `;
  if (sup.count !== 1) {
    throw new Error('sibling_lost_during_publish');
  }
}

export async function setOrphanMarker(
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
 * Guarded candidate-row mutation shared by the edit-publisher 409 dispositions
 * (edit-publish-errors.ts `handle409Disposition`): apply the disposition's
 * `setBody` to the publishable candidate row and assert exactly one publishable
 * row was hit — else throw `candidate_lost_during_publish`, forcing the tx to
 * ROLLBACK. The publishable-status WHERE guard + `RETURNING 1` + affected-row
 * assertion live here once; each caller supplies only its SET body.
 *
 * `setBody` is the SET column list as a raw `tx`` fragment (no `SET` keyword —
 * that stays in the template so the tenant-scope scanner reads
 * `UPDATE responses SET …`, not an interpolated table alias). The template
 * whitespace is byte-matched to the two inline blocks it replaced (409
 * `matches_our_text` → posted, and `mismatch`-no-DELETE → superseded); the
 * `mismatch`-after-DELETE block sits one nesting level deeper and is NOT routed
 * here (its SQL text carries a 2-space-deeper indent — see edit-publish-errors.ts).
 */
export async function markCandidateOrThrow(
  tx: postgres.TransactionSql,
  args: { responseId: string; businessId: string; setBody: postgres.Fragment },
): Promise<void> {
  const { responseId, businessId, setBody } = args;
  const updated = await tx`
      UPDATE responses
      SET ${setBody}
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
  if (updated.count !== 1) {
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
export async function markCandidatePermanentFailedInTx(
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
 *   - Operates on the open tx so reads/writes share our locks.
 *   - Does NOT call markOutboxCompleted (the dispatcher owns the outbox).
 *   - Picks posting_error based on postDeleteCommitted so the orphan marker
 *     survives drain re-enqueue (§4.5):
 *       postDeleteCommitted=false → 'zernio_auth_error'
 *       postDeleteCommitted=true  → 'zernio_auth_error_after_delete_succeeded'
 *   - Optionally supersedes the sibling 'posted' row (post-DELETE-success only).
 */
export async function applyAuthErrorTerminalInTx(
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
      ${tx.json(reconnectPayload as never)}, 0, 5
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
        ${tx.json(lostPayload as never)}, 0, 5
      )
    `;
  }
}
