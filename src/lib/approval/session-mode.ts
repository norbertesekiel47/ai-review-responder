// src/lib/approval/session-mode.ts
//
// Session-authenticated approval (owner dashboard). The owner is
// authenticated via Supabase session — no link/device operations are
// needed, but any open approval links for the response are revoked
// to prevent the owner from then clicking an emailed link and double-acting.
//
// `establishApprovalSession` lives here too: it's called by the approval
// page session route to bind the device cookie to a token-flow link.
// Despite the name overlap with this module's "session", it operates on
// the same approval_links rows as token-mode. We keep it here because
// the route under /api/approve/[token]/session calls it.

import { distance } from 'fastest-levenshtein';
import type postgres from 'postgres';
import { sanitizePublicResponseText } from '@/lib/shared/sanitize';
import { InvalidTokenError, DeviceConflictError, EmptyEditedResponseError } from './errors';
import {
  lockPendingResponse,
  revokeOpenLinksForResponse,
} from './locks';
import {
  insertAuditLog,
  insertAuditLogSession,
  type AuditContext,
  type SessionAuditContext,
} from './audit';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { enqueueGenerateResponse, enqueuePublishResponse } from '@/lib/shared/job-outbox-helpers';
import { anchorReviewLockOrder, recordOwnerDecisionOutcome } from './outcomes';
import { markResponseApproved, markResponseEdited, markResponseSuperseded } from './transitions';

type TxClient = postgres.TransactionSql;

/**
 * Bind a device cookie to an approval link, or verify it matches the already-bound device.
 * First visit binds; repeat visits from the same device are no-ops; different device throws.
 */
export async function establishApprovalSession(
  tx: TxClient,
  linkId: string,
  deviceCookieHash: string,
  audit: AuditContext,
): Promise<void> {
  const rows = await tx<{ device_cookie_hash: string | null; response_id: string; business_id: string }[]>`
    SELECT device_cookie_hash, response_id, business_id
    FROM approval_links
    WHERE id = ${linkId}
    FOR UPDATE
  `;

  const link = rows[0];
  if (!link) throw new InvalidTokenError();

  if (link.device_cookie_hash === null) {
    await tx`
      UPDATE approval_links SET device_cookie_hash = ${deviceCookieHash} WHERE id = ${linkId}
    `;
  } else if (link.device_cookie_hash !== deviceCookieHash) {
    throw new DeviceConflictError();
  }

  await insertAuditLog(tx, link.response_id, link.business_id, 'session_bind', audit);
}

/**
 * Approve a response via authenticated owner session (dashboard).
 * No link/device operations — the owner is authenticated via Supabase session.
 */
export async function approveBySession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  audit: SessionAuditContext,
  correlationId?: string,
): Promise<void> {
  await anchorReviewLockOrder(tx, responseId, businessId);
  const resp = await lockPendingResponse(tx, responseId);
  await revokeOpenLinksForResponse(tx, responseId);

  await markResponseApproved(tx, {
    responseId,
    businessId,
    method: APPROVAL_METHOD.OWNER,
  });

  await recordOwnerDecisionOutcome(tx, {
    reviewId: resp.review_id,
    businessId,
    outcomeKind: 'reply_approved_no_edit',
  });

  await enqueuePublishResponse(tx, {
    responseId,
    businessId,
    correlationId,
  });

  await insertAuditLogSession(tx, responseId, businessId, 'approve', audit, undefined, {
    responseTextAtApproval: resp.response_text,
  });
}

/**
 * Approve with owner edits via authenticated session (dashboard).
 * Computes edit distance, stores edited text, and enqueues publish_response.
 */
export async function editBySession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  editedText: string,
  audit: SessionAuditContext,
  correlationId?: string,
): Promise<void> {
  const sanitizedText = sanitizePublicResponseText(editedText);
  if (sanitizedText.length === 0) throw new EmptyEditedResponseError();

  await anchorReviewLockOrder(tx, responseId, businessId);
  const resp = await lockPendingResponse(tx, responseId);
  await revokeOpenLinksForResponse(tx, responseId);

  const editDist = distance(resp.original_draft_text, sanitizedText);

  await markResponseEdited(tx, {
    responseId,
    businessId,
    method: APPROVAL_METHOD.OWNER,
    editedText: sanitizedText,
    editDistance: editDist,
  });

  await recordOwnerDecisionOutcome(tx, {
    reviewId: resp.review_id,
    businessId,
    outcomeKind: 'reply_edited_by_owner',
  });

  await enqueuePublishResponse(tx, {
    responseId,
    businessId,
    correlationId,
  });

  await insertAuditLogSession(tx, responseId, businessId, 'edit', audit, { edit_distance: editDist }, {
    responseTextAtApproval: sanitizedText,
  });
}

/**
 * Request regeneration via authenticated session (dashboard).
 * Supersedes the current response and enqueues generate_response with version+1.
 *
 * Takes the reviews-row lock-order anchor FIRST (#1444) even though it
 * records no owner-decision outcome: the auto-policy downgrade lane
 * (worker/jobs/publisher/auto-policy-downgrade.ts) and the publisher
 * failed-hook (worker/jobs/publisher/failed-hook.ts) both lock businesses
 * FOR UPDATE before responses FOR UPDATE — the opposite of this lane's
 * responses-then-businesses order (locks.ts's lockPendingResponse) — and
 * neither filters its response lock by status, so an unanchored regenerate
 * racing either lane on the same response closes an AB-BA cycle. Anchoring
 * on the SAME reviews row those lanes take first serializes the two
 * transactions before either can reach a response or business row.
 */
export async function regenerateBySession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  audit: SessionAuditContext,
  correlationId?: string,
): Promise<void> {
  await anchorReviewLockOrder(tx, responseId, businessId);
  const resp = await lockPendingResponse(tx, responseId);
  await revokeOpenLinksForResponse(tx, responseId);

  await markResponseSuperseded(tx, { responseId, businessId });

  await enqueueGenerateResponse(tx, {
    reviewId: resp.review_id,
    businessId,
    version: resp.version + 1,
    originLane: GENERATE_RESPONSE_ORIGIN_LANE.REGENERATE,
    correlationId,
  });

  await insertAuditLogSession(tx, responseId, businessId, 'regenerate', audit);
}
