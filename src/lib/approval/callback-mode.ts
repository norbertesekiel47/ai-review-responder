// src/lib/approval/callback-mode.ts
//
// Inline-callback approval (Telegram, WhatsApp button taps). Authorization
// is provider-signature + sender-handle bound in the ingress layer; here we
// only re-check link state under the transactional lock and assemble the
// audit metadata.
//
// Unlike token-mode and session-mode, the caller does not provide a
// correlation_id — we recover it from the upstream generate_response
// outbox row via recoverCorrelationId so the chain stays linked.

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import {
  lockLinkByIdForCallback,
  lockPendingResponse,
  consumeLink,
  revokeSiblings,
} from './locks';
import { insertAuditLog, buildCallbackAudit } from './audit';
import { recoverCorrelationId } from './correlation';
import type { CallbackApprovalInput } from './types';
import type { PublishResponsePayload, GenerateResponsePayload } from '@/lib/shared/worker-types';

export type { CallbackApprovalInput };

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
    await insertAuditLog(tx, link.response_id, link.business_id, `approved_via_${input.viaChannel}`, audit, metadata, {
      responseTextAtApproval: response.response_text,
    });
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
