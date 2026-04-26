import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { sql, jsonb } from '@/lib/db/server';
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
  lockLinkByIdForCallback,
} from './locks';
import { approve, edit, regenerate } from './token-mode';
import {
  establishApprovalSession,
  approveBySession,
  editBySession,
  regenerateBySession,
} from './session-mode';
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
  establishApprovalSession,
  approveBySession,
  editBySession,
  regenerateBySession,
};
export type { AuditContext, SessionAuditContext, CallbackAuditContext, CallbackAuditArtifacts };
export type { ApprovalLink };

/**
 * Postgres.js TransactionSql type used by sql.begin() callback.
 */
type TxClient = postgres.TransactionSql;

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
  await sql.begin(async (tx: TxClient) => {
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
  await sql.begin(async (tx: TxClient) => {
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
