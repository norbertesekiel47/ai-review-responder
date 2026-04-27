// src/lib/approval/locks.ts
//
// Lock + validation helpers shared by all three approval modes.
// Each helper takes a Postgres.js TransactionSql and uses
// SELECT ... FOR UPDATE to hold row-level locks for the duration of
// the surrounding transaction.

import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import {
  InvalidTokenError,
  ExpiredTokenError,
  RevokedTokenError,
  ConsumedTokenError,
  DeviceConflictError,
  ResponseNotPendingError,
  ConsumedLinkError,
  RevokedLinkError,
  ExpiredLinkError,
  ChannelMismatchError,
} from './errors';
import type { ApprovalLink } from './types';

type TxClient = postgres.TransactionSql;

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
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

export function verifyDevice(link: ApprovalLink, deviceCookieHash: string): void {
  if (link.device_cookie_hash !== deviceCookieHash) {
    throw new DeviceConflictError();
  }
}

export async function consumeLink(tx: TxClient, linkId: string): Promise<void> {
  await tx`UPDATE approval_links SET consumed_at = NOW() WHERE id = ${linkId}`;
}

/**
 * Lock the response row and verify it is still pending_approval.
 * Must be called BEFORE consumeLink so the transaction rolls back
 * cleanly if the response is no longer actionable.
 */
export async function lockPendingResponse(
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

export async function revokeSiblings(tx: TxClient, responseId: string, excludeLinkId: string): Promise<void> {
  await tx`
    UPDATE approval_links
    SET revoked_at = NOW()
    WHERE response_id = ${responseId}
      AND id != ${excludeLinkId}
      AND consumed_at IS NULL
  `;
}

/**
 * Revoke ALL open (unconsumed, unrevoked, unexpired) approval links for a response.
 * Used by session-based dashboard actions where there is no "current link" to exclude.
 * Token-based actions use revokeSiblings() which excludes the consumed link.
 */
export async function revokeOpenLinksForResponse(tx: TxClient, responseId: string): Promise<void> {
  await tx`
    UPDATE approval_links
    SET revoked_at = NOW()
    WHERE response_id = ${responseId}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > NOW()
  `;
}

export async function lockLinkByIdForCallback(
  tx: TxClient,
  approvalLinkId: string,
  expectedChannel: string,
): Promise<ApprovalLink> {
  const rows = await tx<ApprovalLink[]>`
    SELECT id, response_id, business_id, token_hash, channel, expires_at, consumed_at, revoked_at, device_cookie_hash, created_at
    FROM approval_links
    WHERE id = ${approvalLinkId}
    FOR UPDATE
  `;
  const link = rows[0];
  if (!link) throw new InvalidTokenError();
  if (link.channel !== expectedChannel) throw new ChannelMismatchError(expectedChannel, link.channel);
  if (link.consumed_at !== null) throw new ConsumedLinkError();
  if (link.revoked_at !== null) throw new RevokedLinkError();
  if (new Date(link.expires_at) <= new Date()) throw new ExpiredLinkError();
  return link;
}
