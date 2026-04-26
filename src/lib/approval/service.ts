import { v7 as uuidv7 } from 'uuid';
import { distance } from 'fastest-levenshtein';
import type postgres from 'postgres';
import { sql, jsonb } from '@/lib/db/server';
import {
  InvalidTokenError,
  DeviceConflictError,
} from './errors';
import { recoverCorrelationId } from './correlation';
import type { PublishResponsePayload, GenerateResponsePayload } from '@/lib/shared/worker-types';
import {
  insertAuditLog,
  insertAuditLogSession,
  buildCallbackAudit,
  type AuditContext,
  type SessionAuditContext,
  type CallbackAuditContext,
  type CallbackAuditArtifacts,
} from './audit';
import {
  lockValidLink,
  consumeLink,
  lockPendingResponse,
  revokeSiblings,
  revokeOpenLinksForResponse,
  lockLinkByIdForCallback,
} from './locks';
import { approve, edit, regenerate } from './token-mode';
import type { ApprovalLink } from './types';

// Re-export the lock + audit modules' public API so existing
// `import { ... } from '@/lib/approval/service'` continues to resolve.
export {
  insertAuditLog,
  insertAuditLogSession,
  buildCallbackAudit,
  lockValidLink,
  approve,
  edit,
  regenerate,
};
export type { AuditContext, SessionAuditContext, CallbackAuditContext, CallbackAuditArtifacts };
export type { ApprovalLink };

/**
 * Postgres.js TransactionSql type used by sql.begin() callback.
 */
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

// ---------------------------------------------------------------------------
// Session-authenticated approval (owner dashboard)
// ---------------------------------------------------------------------------

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
  await lockPendingResponse(tx, responseId);
  await revokeOpenLinksForResponse(tx, responseId);

  await tx`
    UPDATE responses
    SET status = 'approved', approved_at = NOW(), approved_text = response_text
    WHERE id = ${responseId}
  `;

  const payload: PublishResponsePayload = {
    response_id: responseId,
    business_id: businessId,
    correlation_id: correlationId,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${responseId}, ${jsonb(payload)}, 'pending')
  `;

  await insertAuditLogSession(tx, responseId, businessId, 'approve', audit);
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
  const resp = await lockPendingResponse(tx, responseId);
  await revokeOpenLinksForResponse(tx, responseId);

  const editDist = distance(resp.original_draft_text, editedText);

  await tx`
    UPDATE responses
    SET status = 'edited',
        approved_at = NOW(),
        approved_text = ${editedText},
        edited_text = ${editedText},
        edit_distance = ${editDist}
    WHERE id = ${responseId}
  `;

  const payload: PublishResponsePayload = {
    response_id: responseId,
    business_id: businessId,
    correlation_id: correlationId,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${responseId}, ${jsonb(payload)}, 'pending')
  `;

  await insertAuditLogSession(tx, responseId, businessId, 'edit', audit, { edit_distance: editDist });
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
    UPDATE responses SET status = 'superseded' WHERE id = ${responseId}
  `;

  const payload: GenerateResponsePayload = {
    review_id: resp.review_id,
    business_id: businessId,
    version: resp.version + 1,
    correlation_id: correlationId,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'generate_response', 'review', ${resp.review_id}, ${jsonb(payload)}, 'pending')
  `;

  await insertAuditLogSession(tx, responseId, businessId, 'regenerate', audit);
}

// ---------------------------------------------------------------------------
// Inline-callback approval (Telegram / future WhatsApp button taps)
// ---------------------------------------------------------------------------

export interface CallbackApprovalInput {
  approvalLinkId: string;
  chatHandle: string;
  viaChannel: 'telegram' | 'whatsapp';
  audit: CallbackAuditContext;
}

/**
 * Approve via inline-button callback (Telegram / WhatsApp).
 * Authorization is provider-signature + sender-handle bound in the ingress layer.
 * Throws typed link-state errors for caller classification.
 */
export async function approveViaCallback(input: CallbackApprovalInput): Promise<void> {
  await sql.begin(async (tx) => {
    const link = await lockLinkByIdForCallback(tx, input.approvalLinkId, input.viaChannel);
    const response = await lockPendingResponse(tx, link.response_id);
    await consumeLink(tx, link.id);
    await tx`
      UPDATE responses
      SET status = 'approved', approved_at = NOW(), approved_text = response_text
      WHERE id = ${link.response_id}
    `;
    await revokeSiblings(tx, link.response_id, link.id);

    const correlationId = await recoverCorrelationId(tx, {
      reviewId: response.review_id,
      responseId: link.response_id,
    });

    const payload: PublishResponsePayload = {
      response_id: link.response_id,
      business_id: link.business_id,
      correlation_id: correlationId,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (${uuidv7()}, 'publish_response', 'response', ${link.response_id}, ${jsonb(payload)}, 'pending')
    `;

    const { audit, metadata } = buildCallbackAudit(link, input, correlationId);
    await insertAuditLog(tx, link.response_id, link.business_id, `approved_via_${input.viaChannel}`, audit, metadata);
  });
}

/**
 * Regenerate via inline-button callback. Marks current response superseded,
 * enqueues generate_response. A new approval cycle will follow.
 */
export async function regenerateViaCallback(input: CallbackApprovalInput): Promise<void> {
  await sql.begin(async (tx) => {
    const link = await lockLinkByIdForCallback(tx, input.approvalLinkId, input.viaChannel);
    const response = await lockPendingResponse(tx, link.response_id);
    await consumeLink(tx, link.id);
    await revokeSiblings(tx, link.response_id, link.id);
    await tx`UPDATE responses SET status = 'superseded' WHERE id = ${link.response_id}`;

    const correlationId = await recoverCorrelationId(tx, {
      reviewId: response.review_id,
      responseId: link.response_id,
    });

    const payload: GenerateResponsePayload = {
      review_id: response.review_id,
      business_id: link.business_id,
      version: response.version + 1,
      correlation_id: correlationId,
    };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (${uuidv7()}, 'generate_response', 'review', ${response.review_id}, ${jsonb(payload)}, 'pending')
    `;

    const { audit, metadata } = buildCallbackAudit(link, input, correlationId);
    await insertAuditLog(tx, link.response_id, link.business_id, `regenerated_via_${input.viaChannel}`, audit, metadata);
  });
}
