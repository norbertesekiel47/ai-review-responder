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

import { sql } from '@/lib/db/server';
import {
  lockLinkByIdForCallback,
  lockPendingResponse,
  consumeLink,
  revokeSiblings,
} from './locks';
import { insertAuditLog, buildCallbackAudit } from './audit';
import { recoverCorrelationId } from './correlation';
import type { CallbackApprovalInput } from './types';
import { GENERATE_RESPONSE_ORIGIN_LANE } from '@/lib/shared/worker-types';
import { APPROVAL_METHOD } from '@/lib/auto-approval/types';
import { enqueueGenerateResponse, enqueuePublishResponse } from '@/lib/shared/job-outbox-helpers';
import {
  assertWritableSubscriptionForBusiness,
  throwIfReadOnly,
} from '@/lib/shared/writable-subscription';

export type { CallbackApprovalInput };

/**
 * Approve via inline-button callback (Telegram / WhatsApp).
 * Authorization is provider-signature + sender-handle bound in the ingress layer.
 * Throws typed link-state errors for caller classification.
 */
export async function approveViaCallback(input: CallbackApprovalInput): Promise<void> {
  await sql.begin(async (tx) => {
    const link = await lockLinkByIdForCallback(tx, input.approvalLinkId, input.viaChannel);
    throwIfReadOnly(await assertWritableSubscriptionForBusiness(link.business_id, tx));

    const response = await lockPendingResponse(tx, link.response_id);
    await consumeLink(tx, link.id);
    await tx`
      UPDATE responses
      SET status = 'approved',
          approval_method = ${APPROVAL_METHOD.OWNER},
          approved_at = NOW(),
          approved_text = response_text,
          posting_error = NULL
      WHERE id = ${link.response_id}
    `;
    await revokeSiblings(tx, link.response_id, link.id);

    const correlationId = await recoverCorrelationId(tx, {
      reviewId: response.review_id,
      responseId: link.response_id,
    });

    await enqueuePublishResponse(tx, {
      responseId: link.response_id,
      businessId: link.business_id,
      correlationId,
    });

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
    throwIfReadOnly(await assertWritableSubscriptionForBusiness(link.business_id, tx));

    const response = await lockPendingResponse(tx, link.response_id);
    await consumeLink(tx, link.id);
    await revokeSiblings(tx, link.response_id, link.id);
    await tx`UPDATE responses SET status = 'superseded' WHERE id = ${link.response_id}`;

    const correlationId = await recoverCorrelationId(tx, {
      reviewId: response.review_id,
      responseId: link.response_id,
    });

    await enqueueGenerateResponse(tx, {
      reviewId: response.review_id,
      businessId: link.business_id,
      version: response.version + 1,
      originLane: GENERATE_RESPONSE_ORIGIN_LANE.REGENERATE,
      correlationId,
    });

    const { audit, metadata } = buildCallbackAudit(link, input, correlationId);
    await insertAuditLog(tx, link.response_id, link.business_id, `regenerated_via_${input.viaChannel}`, audit, metadata);
  });
}
