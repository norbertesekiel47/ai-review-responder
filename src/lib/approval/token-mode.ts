// src/lib/approval/token-mode.ts
//
// Token-mode approve / edit / regenerate. Caller authentication is by
// raw approval token + bound device cookie (verifyDevice). See locks.ts
// for the lock helpers and audit.ts for the audit writers.
//
// Each function preserves the exact flow of the pre-split service.ts:
// verifyDevice → lockPendingResponse → consumeLink → mutate response →
// revokeSiblings → enqueue follow-up outbox row → write audit log.
// State change + outbox enqueue stay in the SAME transaction.

import { v7 as uuidv7 } from 'uuid';
import { distance } from 'fastest-levenshtein';
import type postgres from 'postgres';
import { jsonb } from '@/lib/db/server';
import { sanitizePublicResponseText } from '@/lib/shared/sanitize';
import {
  verifyDevice,
  lockPendingResponse,
  consumeLink,
  revokeSiblings,
} from './locks';
import { insertAuditLog, type AuditContext } from './audit';
import { EmptyEditedResponseError } from './errors';
import type { ApprovalLink } from './types';
import type { PublishResponsePayload, GenerateResponsePayload } from '@/lib/shared/worker-types';

type TxClient = postgres.TransactionSql;

/**
 * Approve a response as-is. Validates response is still pending,
 * consumes the link, marks response approved, revokes sibling links,
 * and enqueues publish_response.
 *
 * Response is locked BEFORE the link is consumed. If the response is
 * no longer pending_approval, throws ResponseNotPendingError and the
 * entire transaction rolls back — no link is consumed, no false success.
 */
export async function approve(
  tx: TxClient,
  link: ApprovalLink,
  deviceCookieHash: string,
  audit: AuditContext,
  correlationId?: string,
): Promise<void> {
  verifyDevice(link, deviceCookieHash);
  const resp = await lockPendingResponse(tx, link.response_id);
  await consumeLink(tx, link.id);

  await tx`
    UPDATE responses
    SET status = 'approved', approved_at = NOW(), approved_text = response_text
    WHERE id = ${link.response_id}
  `;

  await revokeSiblings(tx, link.response_id, link.id);

  const payload: PublishResponsePayload = {
    response_id: link.response_id,
    business_id: link.business_id,
    correlation_id: correlationId,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${link.response_id}, ${jsonb(payload)}, 'pending')
  `;

  await insertAuditLog(tx, link.response_id, link.business_id, 'approve', audit, undefined, {
    responseTextAtApproval: resp.response_text,
  });
}

/**
 * Approve with owner edits. Locks response first, computes edit distance,
 * stores edited text, and enqueues publish_response.
 */
export async function edit(
  tx: TxClient,
  link: ApprovalLink,
  editedText: string,
  deviceCookieHash: string,
  audit: AuditContext,
  correlationId?: string,
): Promise<void> {
  verifyDevice(link, deviceCookieHash);
  const sanitizedText = sanitizePublicResponseText(editedText);
  if (sanitizedText.length === 0) throw new EmptyEditedResponseError();

  const resp = await lockPendingResponse(tx, link.response_id);
  await consumeLink(tx, link.id);

  const editDist = distance(resp.original_draft_text, sanitizedText);

  await tx`
    UPDATE responses
    SET status = 'edited',
        approved_at = NOW(),
        approved_text = ${sanitizedText},
        edited_text = ${sanitizedText},
        edit_distance = ${editDist}
    WHERE id = ${link.response_id}
  `;

  await revokeSiblings(tx, link.response_id, link.id);

  const payload: PublishResponsePayload = {
    response_id: link.response_id,
    business_id: link.business_id,
    correlation_id: correlationId,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${link.response_id}, ${jsonb(payload)}, 'pending')
  `;

  await insertAuditLog(tx, link.response_id, link.business_id, 'edit', audit, { edit_distance: editDist }, {
    responseTextAtApproval: sanitizedText,
  });
}

/**
 * Request a regeneration. Locks response to verify still pending,
 * supersedes it, revokes all open links, and enqueues generate_response
 * with an incremented version.
 */
export async function regenerate(
  tx: TxClient,
  link: ApprovalLink,
  deviceCookieHash: string,
  audit: AuditContext,
  correlationId?: string,
): Promise<void> {
  verifyDevice(link, deviceCookieHash);
  const resp = await lockPendingResponse(tx, link.response_id);
  await consumeLink(tx, link.id);
  await revokeSiblings(tx, link.response_id, link.id);

  await tx`
    UPDATE responses SET status = 'superseded' WHERE id = ${link.response_id}
  `;

  const payload: GenerateResponsePayload = {
    review_id: resp.review_id,
    business_id: link.business_id,
    version: resp.version + 1,
    correlation_id: correlationId,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'generate_response', 'review', ${resp.review_id}, ${jsonb(payload)}, 'pending')
  `;

  await insertAuditLog(tx, link.response_id, link.business_id, 'regenerate', audit);
}
