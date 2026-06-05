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
  const resp = await lockPendingResponse(tx, responseId);
  await revokeOpenLinksForResponse(tx, responseId);

  await tx`
    UPDATE responses
    SET status = 'approved',
        approval_method = ${APPROVAL_METHOD.OWNER},
        approved_at = NOW(),
        approved_text = response_text,
        posting_error = NULL
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;

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

  const resp = await lockPendingResponse(tx, responseId);
  await revokeOpenLinksForResponse(tx, responseId);

  const editDist = distance(resp.original_draft_text, sanitizedText);

  await tx`
    UPDATE responses
    SET status = 'edited',
        approval_method = ${APPROVAL_METHOD.OWNER},
        approved_at = NOW(),
        approved_text = ${sanitizedText},
        edited_text = ${sanitizedText},
        edit_distance = ${editDist},
        posting_error = NULL
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;

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
 */
export async function regenerateBySession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  audit: SessionAuditContext,
  correlationId?: string,
): Promise<void> {
  const resp = await lockPendingResponse(tx, responseId);
  await revokeOpenLinksForResponse(tx, responseId);

  await tx`
    UPDATE responses
    SET status = 'superseded'
    WHERE id = ${responseId}
      AND business_id = ${businessId}
  `;

  await enqueueGenerateResponse(tx, {
    reviewId: resp.review_id,
    businessId,
    version: resp.version + 1,
    originLane: GENERATE_RESPONSE_ORIGIN_LANE.REGENERATE,
    correlationId,
  });

  await insertAuditLogSession(tx, responseId, businessId, 'regenerate', audit);
}
