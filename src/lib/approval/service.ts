import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { distance } from 'fastest-levenshtein';
import type postgres from 'postgres';
import {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
  ResponseNotPendingError,
} from './errors';
import type { PublishResponsePayload, GenerateResponsePayload } from '@/lib/shared/worker-types';

/**
 * Postgres.js TransactionSql type used by sql.begin() callback.
 */
type TxClient = postgres.TransactionSql;

export interface ApprovalLink {
  id: string;
  response_id: string;
  business_id: string;
  token_hash: string;
  channel: string;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
  device_cookie_hash: string | null;
  created_at: Date;
}

export interface AuditContext {
  tokenHash: string;
  deviceCookieHash: string | null;
  ipAddress: string | null;
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

async function insertAuditLog(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: AuditContext,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, token_hash, device_cookie_hash, action, ip_address, metadata)
    VALUES (
      ${uuidv7()},
      ${responseId},
      ${businessId},
      ${audit.tokenHash},
      ${audit.deviceCookieHash},
      ${action},
      ${audit.ipAddress},
      ${JSON.stringify(metadata ?? {})}::jsonb
    )
  `;
}

/**
 * Lock and validate an approval link by raw token.
 * Uses SELECT ... FOR UPDATE to hold a row-level lock for the duration of the transaction.
 */
export async function lockValidLink(tx: TxClient, rawToken: string): Promise<ApprovalLink> {
  const tokenHash = hashToken(rawToken);

  const rows = await tx<ApprovalLink[]>`
    SELECT id, response_id, business_id, token_hash, channel, expires_at, consumed_at, revoked_at, device_cookie_hash, created_at
    FROM approval_links
    WHERE token_hash = ${tokenHash}
    FOR UPDATE
  `;

  const link = rows[0];
  if (!link) throw new InvalidTokenError();
  if (link.consumed_at !== null) throw new ConsumedTokenError();
  if (link.revoked_at !== null) throw new RevokedTokenError();
  if (new Date(link.expires_at) <= new Date()) throw new ExpiredTokenError();

  return link;
}

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

function verifyDevice(link: ApprovalLink, deviceCookieHash: string): void {
  if (link.device_cookie_hash !== deviceCookieHash) {
    throw new DeviceConflictError();
  }
}

async function consumeLink(tx: TxClient, linkId: string): Promise<void> {
  await tx`UPDATE approval_links SET consumed_at = NOW() WHERE id = ${linkId}`;
}

/**
 * Lock the response row and verify it is still pending_approval.
 * Must be called BEFORE consumeLink so the transaction rolls back
 * cleanly if the response is no longer actionable.
 */
async function lockPendingResponse(
  tx: TxClient,
  responseId: string,
): Promise<{ status: string; original_draft_text: string; version: number; review_id: string }> {
  const rows = await tx<{ status: string; original_draft_text: string; version: number; review_id: string }[]>`
    SELECT status, original_draft_text, version, review_id
    FROM responses WHERE id = ${responseId}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new ResponseNotPendingError('not_found');
  if (row.status !== 'pending_approval') throw new ResponseNotPendingError(row.status);
  return row;
}

async function revokeSiblings(tx: TxClient, responseId: string, excludeLinkId: string): Promise<void> {
  await tx`
    UPDATE approval_links
    SET revoked_at = NOW()
    WHERE response_id = ${responseId}
      AND id != ${excludeLinkId}
      AND consumed_at IS NULL
  `;
}

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
): Promise<void> {
  verifyDevice(link, deviceCookieHash);
  await lockPendingResponse(tx, link.response_id);
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
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${link.response_id}, ${JSON.stringify(payload)}::jsonb, 'pending')
  `;

  await insertAuditLog(tx, link.response_id, link.business_id, 'approve', audit);
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
): Promise<void> {
  verifyDevice(link, deviceCookieHash);
  const resp = await lockPendingResponse(tx, link.response_id);
  await consumeLink(tx, link.id);

  const editDist = distance(resp.original_draft_text, editedText);

  await tx`
    UPDATE responses
    SET status = 'edited',
        approved_at = NOW(),
        approved_text = ${editedText},
        edited_text = ${editedText},
        edit_distance = ${editDist}
    WHERE id = ${link.response_id}
  `;

  await revokeSiblings(tx, link.response_id, link.id);

  const payload: PublishResponsePayload = {
    response_id: link.response_id,
    business_id: link.business_id,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${link.response_id}, ${JSON.stringify(payload)}::jsonb, 'pending')
  `;

  await insertAuditLog(tx, link.response_id, link.business_id, 'edit', audit, { edit_distance: editDist });
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
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'generate_response', 'review', ${resp.review_id}, ${JSON.stringify(payload)}::jsonb, 'pending')
  `;

  await insertAuditLog(tx, link.response_id, link.business_id, 'regenerate', audit);
}

// ---------------------------------------------------------------------------
// Session-authenticated approval (owner dashboard)
// ---------------------------------------------------------------------------

export interface SessionAuditContext {
  actorUserId: string;
  ipAddress: string | null;
}

async function insertAuditLogSession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: SessionAuditContext,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, token_hash, device_cookie_hash, action, ip_address, metadata, actor_user_id, auth_method)
    VALUES (
      ${uuidv7()}, ${responseId}, ${businessId}, ${null}, ${null},
      ${action}, ${audit.ipAddress}, ${JSON.stringify(metadata ?? {})}::jsonb,
      ${audit.actorUserId}, 'owner_session'
    )
  `;
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
): Promise<void> {
  await lockPendingResponse(tx, responseId);

  await tx`
    UPDATE responses
    SET status = 'approved', approved_at = NOW(), approved_text = response_text
    WHERE id = ${responseId}
  `;

  const payload: PublishResponsePayload = {
    response_id: responseId,
    business_id: businessId,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${responseId}, ${JSON.stringify(payload)}::jsonb, 'pending')
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
): Promise<void> {
  const resp = await lockPendingResponse(tx, responseId);

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
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${responseId}, ${JSON.stringify(payload)}::jsonb, 'pending')
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
): Promise<void> {
  const resp = await lockPendingResponse(tx, responseId);

  await tx`
    UPDATE responses SET status = 'superseded' WHERE id = ${responseId}
  `;

  const payload: GenerateResponsePayload = {
    review_id: resp.review_id,
    business_id: businessId,
    version: resp.version + 1,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'generate_response', 'review', ${resp.review_id}, ${JSON.stringify(payload)}::jsonb, 'pending')
  `;

  await insertAuditLogSession(tx, responseId, businessId, 'regenerate', audit);
}
